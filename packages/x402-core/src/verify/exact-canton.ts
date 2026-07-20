// The `exact-canton` scheme verifier + its Canton-specific primitives. Composes
// the scheme-agnostic checks in ./common with Ed25519 signature verification, the
// Canton key-fingerprint derivation, and the canton-id / canton-payload shape
// guards. Pure and stateless — the stateful guards (nonce replay) and on-chain
// execution stay in the facilitator, which composes this verifier's result.

import { sign as ed25519Sign, verify as ed25519Verify, hashes as ed25519Hashes } from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import type { NetworkId } from "../types/common";
import type { CantonPaymentInner } from "../types/payment";
import type { CantonPaymentRequirements } from "../types/requirements";
import type {
  SchemeVerifier,
  VerifyInvalidReason,
  VerifyRequest,
  VerifyResponse,
  VerifyResponseInvalid,
} from "../types/facilitator";
import type { X402PaymentPayload } from "../types/payment";
import type { X402PaymentRequirements } from "../types/requirements";
import { isExpired, requirementsHashMatches } from "./common";

// @noble/ed25519 v3 needs sha512 wired (same as the facilitator's wallet.ts).
ed25519Hashes.sha512 = sha512;

/**
 * The scheme id this module verifies. Module-private for now — export it when a
 * consumer needs the canonical constant (e.g. the facilitator adopting core, or a
 * client-side scheme-id → verifier factory map) rather than the `"exact-canton"`
 * literal.
 */
const EXACT_CANTON_SCHEME_ID = "exact-canton";

/** Canton hash-purpose tag for key fingerprints. */
const HASH_PURPOSE_FINGERPRINT = Uint8Array.of(0x00, 0x00, 0x00, 0x0c);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** base64 → bytes. Isomorphic: `atob` is global in Node 18+ and browsers. */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Canton key fingerprint for a base64 Ed25519 public key:
 * `1220` + hex(SHA-256(0x0000000c ‖ pubkey)). Must equal the payer party's
 * `::<fingerprint>` suffix. Ported from the facilitator (parity-tested).
 */
export function fingerprintForPublicKey(publicKeyBase64: string): string {
  const pk = base64ToBytes(publicKeyBase64);
  if (pk.length !== 32) throw new Error("ed25519 public key must be 32 bytes");
  return "1220" + bytesToHex(sha256(concatBytes(HASH_PURPOSE_FINGERPRINT, pk)));
}

/** True iff the public key's fingerprint equals the claimed one (case-insensitive). */
export function matchesFingerprint(publicKeyBase64: string, claimedFingerprint: string): boolean {
  return fingerprintForPublicKey(publicKeyBase64).toLowerCase() === claimedFingerprint.toLowerCase();
}

/**
 * Verify an Ed25519 signature (hex) over a prepared-transaction hash (hex) with a
 * base64 public key. Length-checks defensively; returns false on any error.
 */
export function verifySignature(
  hashHex: string,
  signatureHex: string,
  publicKeyBase64: string,
): boolean {
  try {
    const pk = base64ToBytes(publicKeyBase64);
    const sig = hexToBytes(signatureHex);
    const msg = hexToBytes(hashHex);
    if (pk.length !== 32 || sig.length !== 64) return false;
    return ed25519Verify(sig, msg, pk);
  } catch {
    return false;
  }
}

/**
 * Ed25519-sign a prepared-transaction hash (hex) with a base64 32-byte seed,
 * returning the signature as hex. Counterpart to {@link verifySignature} — the
 * signature it produces is exactly what `verifySignature` (and the facilitator)
 * accept.
 */
export function signHash(hashHex: string, privateKeyBase64: string): string {
  const seed = base64ToBytes(privateKeyBase64);
  if (seed.length !== 32) throw new Error("ed25519 private key must be a 32-byte seed");
  return bytesToHex(ed25519Sign(hexToBytes(hashHex), seed));
}

// ─── canton network-id boundary guard ──────────────────────────────────────
// NetworkId is a plain string (scheme-generic); this validates the exact-canton
// `canton:<synchronizer-id>` form at untrusted boundaries (env, raw input).

export function isCantonNetworkId(x: unknown): x is NetworkId {
  return typeof x === "string" && /^canton:.+/.test(x);
}

export function parseCantonNetworkId(s: string): NetworkId {
  if (!isCantonNetworkId(s)) throw new Error(`not a canton network id: ${s}`);
  return s;
}

// ─── canton shape guards (type predicates) ─────────────────────────────────

export function isCantonPaymentRequirements(v: unknown): v is CantonPaymentRequirements {
  if (!isObj(v)) return false;
  return (
    typeof v.scheme === "string" &&
    typeof v.network === "string" &&
    typeof v.maxAmountRequired === "string" &&
    typeof v.payTo === "string" &&
    typeof v.resource === "string" &&
    typeof v.nonce === "string" &&
    typeof v.validBefore === "string" &&
    isObj(v.asset)
  );
}

export function isCantonPaymentInner(v: unknown): v is CantonPaymentInner {
  if (!isObj(v)) return false;
  return (
    typeof v.payer === "string" &&
    typeof v.preparedTransaction === "string" &&
    typeof v.preparedTransactionHash === "string" &&
    typeof v.partySignature === "string" &&
    typeof v.requirementsHash === "string" &&
    typeof v.publicKey === "string" &&
    typeof v.hashingSchemeVersion === "string"
  );
}

export function isVerifyRequest(v: unknown): v is VerifyRequest {
  if (!isObj(v)) return false;
  const payload = v.paymentPayload;
  return (
    v.x402Version === 2 &&
    isObj(payload) &&
    isCantonPaymentInner(payload.payload) &&
    isCantonPaymentRequirements(v.paymentRequirements)
  );
}

// ─── the verifier ───────────────────────────────────────────────────────────

function fail(reason: VerifyInvalidReason, payer?: string): VerifyResponseInvalid {
  return { isValid: false, invalidReason: reason, ...(payer ? { payer } : {}) };
}

/**
 * The pure exact-canton verification, factored out of the facilitator's
 * `V2CantonExact.verify`. Runs the stateless checks in order; the facilitator's
 * stateful checks (nonce replay, min-amount FX policy) and the on-chain execute
 * compose on top of a successful result here.
 */
function verifyExactCanton(
  networkId: NetworkId,
  payload: X402PaymentPayload<unknown>,
  requirements: X402PaymentRequirements<unknown>,
): VerifyResponse {
  // 1. scheme
  if (payload.scheme !== EXACT_CANTON_SCHEME_ID || requirements.scheme !== EXACT_CANTON_SCHEME_ID) {
    return fail("scheme_mismatch");
  }
  // 2. network — payload, requirements, and this verifier's binding must agree
  if (payload.network !== requirements.network || payload.network !== networkId) {
    return fail("network_mismatch");
  }
  // 3. shapes — narrow the unknown inner/requirements before reading fields.
  if (!isCantonPaymentRequirements(requirements) || !isObj(payload.payload)) {
    return fail("internal_error");
  }
  const raw = payload.payload;
  if (typeof raw.publicKey !== "string" || !raw.publicKey) {
    return fail("missing_public_key", typeof raw.payer === "string" ? raw.payer : undefined);
  }
  if (!isCantonPaymentInner(raw)) return fail("internal_error");
  const inner = raw;
  // 4. expiry
  if (isExpired(requirements.validBefore)) return fail("requirements_expired", inner.payer);
  // 5. requirementsHash binds the signed payload to this exact PaymentRequirements
  if (!requirementsHashMatches(requirements, inner.requirementsHash)) {
    return fail("requirements_hash_mismatch", inner.payer);
  }
  // 6. public key well-formed (32-byte Ed25519). Malformed key bytes are
  //    indistinguishable from "no usable key" here → missing_public_key.
  let derivedFingerprint: string;
  try {
    derivedFingerprint = fingerprintForPublicKey(inner.publicKey);
  } catch {
    return fail("missing_public_key", inner.payer);
  }
  // 7. the fingerprint derived from the public key must match the payer's
  //    `::<fingerprint>` suffix (replaces the removed wire `keyFingerprint`)
  const partySuffix = inner.payer.split("::")[1];
  if (!partySuffix || derivedFingerprint.toLowerCase() !== partySuffix.toLowerCase()) {
    return fail("bad_fingerprint", inner.payer);
  }
  // 8. signature over the prepared-transaction hash
  if (!verifySignature(inner.preparedTransactionHash, inner.partySignature, inner.publicKey)) {
    return fail("bad_signature", inner.payer);
  }
  return { isValid: true, payer: inner.payer };
}

/**
 * Build an exact-canton {@link SchemeVerifier} bound to a specific Canton network
 * (`canton:<synchronizer-id>`) — mirroring how the facilitator reads its network
 * from the chain provider. The registry dispatches on `(schemeId, networkId)`.
 */
export function createExactCantonVerifier(networkId: NetworkId): SchemeVerifier {
  return {
    schemeId: EXACT_CANTON_SCHEME_ID,
    networkId,
    verify: (payload, requirements) => verifyExactCanton(networkId, payload, requirements),
  };
}
