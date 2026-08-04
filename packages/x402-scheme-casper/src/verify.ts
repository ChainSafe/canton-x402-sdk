// The exact/casper scheme verifier. Composes the scheme-agnostic checks in
// core's verify/common with the Casper-specific shape guards and the
// authorization↔requirements binding (recipient, amount, validity window).
// Pure and stateless — cryptographic verification of the casper-eip-712
// signature, nonce replay, and on-chain settlement stay in the facilitator,
// which composes this verifier's result.

import { isExpired } from "@chainsafe/x402-core";
import type {
  NetworkId,
  SchemeVerifier,
  VerifyInvalidReason,
  VerifyResponse,
  VerifyResponseInvalid,
  X402PaymentPayload,
  X402PaymentRequirements,
} from "@chainsafe/x402-core";
import type { CasperPaymentInner, CasperPaymentRequirements } from "./types";
import { EXACT_CASPER_SCHEME_ID, isCasperNetworkId } from "./types";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

const HEX_RE = /^[0-9a-fA-F]+$/;
const DECIMAL_RE = /^\d+$/;

// ─── casper shape guards (type predicates) ──────────────────────────────────

export function isCasperPaymentRequirements(v: unknown): v is CasperPaymentRequirements {
  if (!isObj(v)) return false;
  return (
    typeof v.scheme === "string" &&
    isCasperNetworkId(v.network) &&
    typeof v.maxAmountRequired === "string" &&
    typeof v.payTo === "string" &&
    typeof v.resource === "string" &&
    typeof v.nonce === "string" &&
    typeof v.validBefore === "string" &&
    isObj(v.asset) &&
    typeof v.asset.contractHash === "string"
  );
}

export function isCasperPaymentInner(v: unknown): v is CasperPaymentInner {
  if (!isObj(v)) return false;
  const auth = v.authorization;
  return (
    typeof v.signature === "string" &&
    typeof v.publicKey === "string" &&
    isObj(auth) &&
    typeof auth.from === "string" &&
    typeof auth.to === "string" &&
    typeof auth.value === "string" &&
    DECIMAL_RE.test(auth.value as string) &&
    typeof auth.validAfter === "string" &&
    typeof auth.validBefore === "string" &&
    typeof auth.nonce === "string"
  );
}

// ─── the verifier ────────────────────────────────────────────────────────────

function fail(reason: VerifyInvalidReason, payer?: string): VerifyResponseInvalid {
  return { isValid: false, invalidReason: reason, ...(payer ? { payer } : {}) };
}

/**
 * The pure exact/casper verification. Runs the stateless checks in order; the
 * facilitator's checks (casper-eip-712 signature recovery, nonce replay) and
 * the on-chain `transfer_with_authorization` execute compose on top of a
 * successful result here.
 */
function verifyExactCasper(
  networkId: NetworkId,
  payload: X402PaymentPayload<unknown>,
  requirements: X402PaymentRequirements<unknown>,
): VerifyResponse {
  // 1. scheme
  if (payload.scheme !== EXACT_CASPER_SCHEME_ID || requirements.scheme !== EXACT_CASPER_SCHEME_ID) {
    return fail("scheme_mismatch");
  }
  // 2. network — payload, requirements, and this verifier's binding must agree
  if (payload.network !== requirements.network || payload.network !== networkId) {
    return fail("network_mismatch");
  }
  // 3. shapes — narrow the unknown inner/requirements before reading fields.
  if (!isCasperPaymentRequirements(requirements) || !isObj(payload.payload)) {
    return fail("internal_error");
  }
  const raw = payload.payload;
  const payer =
    isObj(raw.authorization) && typeof raw.authorization.from === "string"
      ? raw.authorization.from
      : undefined;
  if (typeof raw.publicKey !== "string" || !raw.publicKey || !HEX_RE.test(raw.publicKey)) {
    return fail("missing_public_key", payer);
  }
  if (!isCasperPaymentInner(raw)) return fail("internal_error", payer);
  const inner = raw;
  const auth = inner.authorization;
  // 4. expiry — both the merchant's requirements and the signed authorization
  //    window (unix seconds) must still be open.
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (isExpired(requirements.validBefore)) return fail("requirements_expired", auth.from);
  if (!DECIMAL_RE.test(auth.validBefore) || Number(auth.validBefore) <= nowSeconds) {
    return fail("requirements_expired", auth.from);
  }
  if (DECIMAL_RE.test(auth.validAfter) && Number(auth.validAfter) > nowSeconds) {
    return fail("requirements_expired", auth.from);
  }
  // 5. binding — the signed authorization must satisfy this exact requirements'
  //    (payTo, maxAmountRequired). The exact scheme has no requirementsHash;
  //    the field-level comparison IS the requirements binding, so a mismatch
  //    surfaces as `requirements_hash_mismatch` (payload signed for different
  //    requirements).
  if (auth.to !== requirements.payTo) return fail("requirements_hash_mismatch", auth.from);
  if (BigInt(auth.value) > BigInt(requirements.maxAmountRequired)) {
    return fail("requirements_hash_mismatch", auth.from);
  }
  // 6. signature well-formed (hex). Recovery of the signer and comparison to
  //    `authorization.from` is the facilitator's job (it owns the
  //    casper-eip-712 domain), mirroring how the canton facilitator resolves
  //    keys the pure verifier can't.
  if (!HEX_RE.test(inner.signature)) return fail("bad_signature", auth.from);
  return { isValid: true, payer: auth.from };
}

/**
 * Build an exact/casper {@link SchemeVerifier} bound to a specific Casper
 * network (`casper:casper` or `casper:casper-test`). The registry dispatches
 * on `(schemeId, networkId)`.
 */
export function createExactCasperVerifier(networkId: NetworkId): SchemeVerifier {
  return {
    schemeId: EXACT_CASPER_SCHEME_ID,
    networkId,
    verify: (payload, requirements) => verifyExactCasper(networkId, payload, requirements),
  };
}
