// The canton-exact scheme verifier + its Canton-specific primitives — that is,
// scheme `exact` on a `canton:*` network. Composes the scheme-agnostic checks in
// ./common with Ed25519 signature verification, the Canton key-fingerprint
// derivation, and the canton-id / canton-payload shape guards. Pure and
// stateless — the stateful guards (nonce replay) and on-chain execution stay in
// the facilitator, which composes this verifier's result.

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
import {
  isValidAmount,
  isExpired,
  ledgerToAtomic,
  requirementsHashMatches,
  WIRE_DECIMALS,
} from "./common";
import { decodePreparedTransaction, type DecodedTransfer } from "./prepared-tx";
import { gunzipPreparedTransaction } from "./prepared-tx-codec";

// @noble/ed25519 v3 needs sha512 wired (same as the facilitator's wallet.ts).
ed25519Hashes.sha512 = sha512;

/**
 * The scheme identifier on the wire, defined by the registered Canton scheme spec
 * (`specs/schemes/exact/scheme_exact_canton.md`). Exported so the facilitator
 * reads it from here rather than repeating the literal.
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

// ─── payload encodings ──────────────────────────────────────────────────────
// The payload carries `preparedTxHash` as lower-case hex and `signature` as
// base64, which are the spec's encodings. signHash / verifySignature stay in hex
// because the facilitator's login flow calls them with hex too. The two
// helpers below convert at the payload boundary, so the hex side never changes.

/** 32 bytes as lower-case hex: the only form `preparedTxHash` takes. */
const PREPARED_TX_HASH = /^[0-9a-f]{64}$/;

/** Standard alphabet, padded, nothing else. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** 64 bytes always encode to 88 characters of padded base64. */
const SIGNATURE_BASE64_LENGTH = 88;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * A hex Ed25519 signature (what {@link signHash} returns) in the base64 form the
 * payload's `signature` carries.
 */
export function signatureToBase64(signatureHex: string): string {
  return bytesToBase64(hexToBytes(signatureHex));
}

/**
 * The payload's `signature` back to hex, for {@link verifySignature}. `null`
 * unless it is canonical standard base64 of exactly 64 bytes. A hex signature
 * is valid base64 (its 128 characters decode to 96 bytes), so the length check
 * is what keeps it from being read as one. Canonical means the encoding
 * {@link signatureToBase64} produces: no URL-safe alphabet, no missing padding,
 * no non-zero padding bits.
 *
 * The length is checked first because the value comes from the client. Run on
 * a few million characters, the regex below exhausts V8's backtracking stack
 * and throws instead of returning false.
 */
export function signatureFromBase64(signatureBase64: string): string | null {
  if (signatureBase64.length !== SIGNATURE_BASE64_LENGTH || !BASE64.test(signatureBase64)) {
    return null;
  }
  const bytes = base64ToBytes(signatureBase64);
  if (bytes.length !== 64 || bytesToBase64(bytes) !== signatureBase64) return null;
  return bytesToHex(bytes);
}

// ─── canton network-id boundary guard ──────────────────────────────────────
// NetworkId is a plain string (scheme-generic); this validates the `canton:<name>`
// form at untrusted boundaries (env, raw input). Shape only — that the name is
// one this deployment settles is the verifier's network check, not this guard's.

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
 * The pure canton-exact verification, factored out of the facilitator's
 * `V2CantonExact.verify`. Runs the stateless checks in order; the facilitator's
 * stateful checks (nonce replay, min-amount FX policy) and the on-chain execute
 * compose on top of a successful result here.
 */
function verifyCantonExact(
  networkId: NetworkId,
  payload: X402PaymentPayload<unknown>,
  requirements: X402PaymentRequirements<unknown>,
): VerifyResponse {
  // 1. scheme — both sides must name the one id the spec defines.
  if (payload.scheme !== EXACT_SCHEME_ID || requirements.scheme !== EXACT_SCHEME_ID) {
    return fail("scheme_mismatch");
  }
  // 2. network — payload, requirements, and this verifier's binding must agree
  if (payload.network !== requirements.network || payload.network !== networkId) {
    return fail("network_mismatch");
  }
  // 3. shapes — narrow the unknown inner/requirements before reading fields.
  //    `assetTransferMethod` is the same literal in both schemas, so once both
  //    pass, the payload's method and the requirements' agree.
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
  // 8. signature over the prepared-transaction hash, each in the one encoding
  //    the spec gives it. The facilitator relays `signature` to the ledger as
  //    is. `preparedTxHash` is keyed on (the facilitator's submissionId), so one
  //    hash has one spelling: an upper-case copy decodes to the same bytes and
  //    would verify, and is still refused.
  const signatureHex = signatureFromBase64(inner.signature);
  if (
    !PREPARED_TX_HASH.test(inner.preparedTxHash) ||
    signatureHex === null ||
    !verifySignature(inner.preparedTxHash, signatureHex, inner.publicKey)
  ) {
    return fail("bad_signature", inner.payer);
  }
  // 9. the signed transfer must actually move what the requirements demand.
  //    requirementsHash proves the payload *references* these requirements;
  //    only decoding the prepared transaction proves it *satisfies* them —
  //    binding sender/receiver/instrument/amount so a valid signature over a
  //    divergent transfer (e.g. to another party, or a smaller amount) is rejected.
  //    The payload carries it gzipped; a member that is malformed or over
  //    either bound is as undecodable as a bad protobuf.
  const prepared = gunzipPreparedTransaction(inner.preparedTransaction);
  const transfer = prepared && decodePreparedTransaction(bytesToBase64(prepared));
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
 * `transfer_mismatch` response's `extensions.detail`. The amount must be EQUAL,
 * not merely sufficient (Rule 4), and the two sides are in different units — the
 * transfer carries an on-ledger Decimal, the requirements an atomic integer at
 * the Token Standard's fixed scale.
 */
export function findTransferMismatch(
  transfer: DecodedTransfer,
  requirements: CantonPaymentRequirements,
  payer: string,
): "sender" | "receiver" | "instrument" | "amount" | null {
  if (transfer.sender !== payer) return "sender";
  if (transfer.receiver !== requirements.payTo) return "receiver";
  // From `extra`, not `asset`: the latter is only a symbol, which cannot say
  // which registry issued the instrument.
  const want = requirements.extra.instrumentId;
  if (transfer.instrumentId.id !== want.id || transfer.instrumentId.admin !== want.admin) {
    return "instrument";
  }
  // EQUAL, not at-least (Rule 4). The two sides are in different units, so both
  // become atomic: the transfer carries an on-ledger Decimal, the quote an
  // atomic integer. One scale for every instrument — see WIRE_DECIMALS.
  const moved = ledgerToAtomic(transfer.amount, WIRE_DECIMALS);
  const quoted = isValidAmount(requirements.amount) ? BigInt(requirements.amount) : null;
  if (moved === null || quoted === null || moved !== quoted) return "amount";
  return null;
}

/**
 * Build a canton-exact {@link SchemeVerifier} bound to one Canton network (a
 * `canton:<name>` — see ../networks). The registry dispatches on
 * `(schemeId, networkId)`.
 *
 * Accepts that scheme id and that network id only; there is no alias set.
 */
export function createCantonExactVerifier(networkId: NetworkId): SchemeVerifier {
  return {
    schemeId: EXACT_SCHEME_ID,
    networkId,
    verify: (payload, requirements) => verifyCantonExact(networkId, payload, requirements),
  };
}
