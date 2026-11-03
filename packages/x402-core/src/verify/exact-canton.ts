// The `exact-canton` scheme verifier + its Canton-specific primitives. Composes
// the scheme-agnostic checks in ./common with Ed25519 signature verification, the
// Canton key-fingerprint derivation, and the canton-id / canton-payload shape
// guards. Pure and stateless — the stateful guards (nonce replay) and on-chain
// execution stay in the facilitator, which composes this verifier's result.

import { sign as ed25519Sign, verify as ed25519Verify, hashes as ed25519Hashes } from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import type { NetworkId } from "../types/common";
import { isCantonPaymentInner } from "../types/payment";
import { CantonPaymentRequirements, isCantonPaymentRequirements } from "../types/requirements";
import type {
  SchemeVerifier,
  VerifyInvalidReason,
  VerifyResponse,
  VerifyResponseInvalid,
} from "../types/facilitator";
import type { X402PaymentPayload } from "../types/payment";
import type { X402PaymentRequirements } from "../types/requirements";
import { amountGte, isExpired, requirementsHashMatches } from "./common";
import { decodePreparedTransaction, type DecodedTransfer } from "./prepared-tx";

// @noble/ed25519 v3 needs sha512 wired (same as the facilitator's wallet.ts).
ed25519Hashes.sha512 = sha512;

/**
 * The id this scheme has always used, and what a verifier advertises unless
 * told otherwise. The one being migrated away from: see
 * {@link ExactCantonVerifierOptions}.
 *
 * Exported now that the facilitator composes this verifier and needs the
 * constant rather than the `"exact-canton"` literal.
 */
export const EXACT_CANTON_SCHEME_ID = "exact-canton";

/**
 * The identifier the registered Canton scheme spec fixes
 * (`specs/schemes/exact/scheme_exact_canton.md`), and where this scheme is
 * headed. A deployment still advertising {@link EXACT_CANTON_SCHEME_ID} cannot
 * be paid by a conforming client at all.
 *
 * Defined here, not in the facilitator, so both ends of the wire read the id
 * from one place.
 */
export const EXACT_SCHEME_ID = "exact";

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
  accepted: Accepted,
  payload: X402PaymentPayload<unknown>,
  requirements: X402PaymentRequirements<unknown>,
): VerifyResponse {
  // 1. scheme — payload and requirements must name the SAME id, and it must be
  // one this deployment accepts. Both halves matter: the equality was implicit
  // while there was one id, and a payload paying `exact` against requirements
  // quoting `exact-canton` is two parties disagreeing about the contract, not a
  // spelling to be smoothed over.
  if (
    payload.scheme !== requirements.scheme ||
    !accepted.schemes.has(payload.scheme)
  ) {
    return fail("scheme_mismatch");
  }
  // 2. network — payload, requirements, and this verifier's binding must agree
  if (
    payload.network !== requirements.network ||
    !accepted.networks.has(payload.network)
  ) {
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
  // 9. the signed transfer must actually move what the requirements demand.
  //    requirementsHash proves the payload *references* these requirements;
  //    only decoding the prepared transaction proves it *satisfies* them —
  //    binding sender/receiver/instrument/amount so a valid signature over a
  //    divergent transfer (e.g. to another party, or a smaller amount) is rejected.
  const transfer = decodePreparedTransaction(inner.preparedTransaction);
  if (!transfer) {
    return { isValid: false, invalidReason: "transfer_mismatch", payer: inner.payer, extensions: { detail: "undecodable" } };
  }
  const mismatch = findTransferMismatch(transfer, requirements, inner.payer);
  if (mismatch) {
    return { isValid: false, invalidReason: "transfer_mismatch", payer: inner.payer, extensions: { detail: mismatch } };
  }
  return { isValid: true, payer: inner.payer };
}

/**
 * Check a decoded transfer against the requirements. Returns `null` when the
 * transfer satisfies them, or a short field detail (`"sender" | "receiver" |
 * "instrument" | "amount"`) naming the first divergence — surfaced in the
 * `transfer_mismatch` response's `extensions.detail`. Overpayment is allowed
 * (`amount >= maxAmountRequired`); the amount compare is decimal-safe.
 */
export function findTransferMismatch(
  transfer: DecodedTransfer,
  requirements: CantonPaymentRequirements,
  payer: string,
): "sender" | "receiver" | "instrument" | "amount" | null {
  if (transfer.sender !== payer) return "sender";
  if (transfer.receiver !== requirements.payTo) return "receiver";
  const want = requirements.asset.instrumentId;
  if (transfer.instrumentId.id !== want.id || transfer.instrumentId.admin !== want.admin) {
    return "instrument";
  }
  if (!amountGte(transfer.amount, requirements.maxAmountRequired)) return "amount";
  return null;
}

/** Every id one verifier answers to, advertised or merely accepted. */
interface Accepted {
  readonly schemes: ReadonlySet<string>;
  readonly networks: ReadonlySet<string>;
}

/**
 * What a verifier advertises, and what else it will take.
 *
 * Shaped for a migration with three stages, each a configuration change rather
 * than a code change:
 *
 * ```ts
 * //    now — advertise and accept the id we always have
 * createExactCantonVerifier(net)
 * //    during — lead with the spec's id, keep paying clients working
 * createExactCantonVerifier(net, {
 *   schemeId: EXACT_SCHEME_ID,
 *   acceptSchemes: [EXACT_CANTON_SCHEME_ID],
 * })
 * //    after — drop the legacy id by deleting one line
 * createExactCantonVerifier(net, { schemeId: EXACT_SCHEME_ID })
 * ```
 *
 * That is why the legacy id is not pinned into the accepted set: it has to be
 * removable, and the spec's id has to be able to become the advertised one.
 *
 * Accept many, advertise one. `schemeId` / `networkId` on the returned verifier
 * are what the registry dispatches on and what `/supported` publishes, so a
 * client is never left guessing which of several ids is the real one.
 */
export interface ExactCantonVerifierOptions {
  /**
   * The scheme id this verifier advertises. Defaults to
   * {@link EXACT_CANTON_SCHEME_ID}; set {@link EXACT_SCHEME_ID} to lead with
   * the identifier the registered spec fixes.
   */
  readonly schemeId?: string;
  /** Accepted but not advertised — the id being migrated away from. */
  readonly acceptSchemes?: readonly string[];
  /**
   * Network ids accepted but not advertised, the same migration in the other
   * dimension: lead with a registered id (`SPEC_DEVNET_NETWORK` and friends in
   * ../networks) while a synchronizer hash is still quoted, then drop the hash.
   */
  readonly acceptNetworks?: readonly NetworkId[];
}

/**
 * Build an exact-canton {@link SchemeVerifier} bound to a specific Canton network
 * (`canton:<synchronizer-id>`) — mirroring how the facilitator reads its network
 * from the chain provider. The registry dispatches on `(schemeId, networkId)`.
 *
 * The verifier always accepts what it advertises; `acceptSchemes` /
 * `acceptNetworks` add ids it will take but not publish.
 */
export function createExactCantonVerifier(
  networkId: NetworkId,
  options: ExactCantonVerifierOptions = {},
): SchemeVerifier {
  const schemeId = options.schemeId ?? EXACT_CANTON_SCHEME_ID;
  const accepted: Accepted = {
    schemes: new Set([schemeId, ...(options.acceptSchemes ?? [])]),
    networks: new Set<string>([networkId, ...(options.acceptNetworks ?? [])]),
  };
  return {
    schemeId,
    networkId,
    verify: (payload, requirements) => verifyExactCanton(accepted, payload, requirements),
  };
}
