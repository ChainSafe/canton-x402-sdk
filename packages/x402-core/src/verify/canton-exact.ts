// The canton-exact scheme verifier + its Canton-specific primitives — that is,
// scheme `exact` on a `canton:*` network. Composes the scheme-agnostic checks in
// ./common with Ed25519 signature verification, the Canton key-fingerprint
// derivation, and the canton-id / canton-payload shape guards. Pure and
// stateless — the stateful guards (replay) and on-chain execution stay in
// the facilitator, which composes this verifier's result.

import {
  sign as ed25519Sign,
  verify as ed25519Verify,
  hashes as ed25519Hashes,
} from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import type { NetworkId } from "../types/common";
import { HashingSchemeVersion, isCantonPaymentInner } from "../types/payment";
import { CantonPaymentRequirements, isCantonPaymentRequirements } from "../types/requirements";
import type {
  SchemeVerifier,
  VerifyInvalidReason,
  SpecVerifyInvalidReason,
  VerifyResponse,
  VerifyResponseInvalid,
} from "../types/facilitator";
import type { X402PaymentPayload } from "../types/payment";
import type { X402PaymentRequirements } from "../types/requirements";
import {
  isValidAmount,
  ledgerToAtomic,
  WIRE_DECIMALS,
} from "./common";
import { decodePreparedTransaction, type DecodedTransfer } from "./prepared-tx";
import { gunzipPreparedTransaction } from "./prepared-tx-codec";
import { computePreparedTransactionHash } from "./prepared-tx-hash";
import { guardPreparedTransaction } from "./prepared-tx-guard";

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

/**
 * How much future an `executeBefore` must have left to be worth accepting.
 * Settling is not instantaneous, so a transfer expiring inside this window is
 * one the ledger refuses after the work of relaying it has been done.
 */
const EXECUTE_BEFORE_MARGIN_MICROS = 5_000_000n;

/** Rule 10: the deadline must be ahead of now by the margin. Absent counts as expired. */
function isTransferExpired(executeBeforeMicros: bigint | undefined, now: number = Date.now()): boolean {
  if (executeBeforeMicros === undefined) return true;
  return executeBeforeMicros <= BigInt(now) * 1000n + EXECUTE_BEFORE_MARGIN_MICROS;
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

/**
 * A refusal. `invalidReason` is the spec's code, the one a client written
 * against the spec matches on. `extensions.reason` is the code this verifier
 * answered with before, kept beside it until those are dropped, and
 * `extensions.detail` says what diverged where there is more to say.
 */
function fail(
  invalidReason: VerifyInvalidReason,
  reason: VerifyInvalidReason,
  payer?: string,
  detail?: string,
): VerifyResponseInvalid {
  return {
    isValid: false,
    invalidReason,
    ...(payer ? { payer } : {}),
    extensions: { reason, ...(detail !== undefined ? { detail } : {}) },
  };
}

/**
 * The suffix a participant appends to the LOGICAL synchronizer id to form the
 * PHYSICAL one it signs into `Metadata.synchronizer_id`:
 * `<protocol-version>-<topology-serial>`. Two decimal runs, one hyphen,
 * nothing else.
 */
const PHYSICAL_SYNCHRONIZER_SUFFIX = /^[0-9]+-[0-9]+$/;

/**
 * Is the signed synchronizer id the one the merchant quoted?
 *
 * `prepare` takes the logical id and refuses the physical one, yet the bytes
 * it returns carry the physical form — so exact equality would refuse every
 * honest payment. A suffixed match is not a weakening: the `1220…` is the
 * domain's namespace fingerprint, so `<quoted>::<n>-<m>` is provably the same
 * domain at a participant-chosen version and serial. Another name, another
 * fingerprint, a non-numeric or three-part suffix, or any trailing text is
 * refused, and an absent id counts as a mismatch.
 */
function synchronizerMatches(signed: string | undefined, quoted: string): boolean {
  if (signed === undefined) return false;
  if (signed === quoted) return true;
  if (!signed.startsWith(`${quoted}::`)) return false;
  return PHYSICAL_SYNCHRONIZER_SUFFIX.test(signed.slice(quoted.length + 2));
}

/**
 * The scheme's code for each field {@link findTransferMismatch} can name.
 *
 * Typed to those alone: `VerifyInvalidReason` also admits our protocol-level
 * codes, and one of them sat here answering the synchronizer — a slot no
 * spec-written client would have matched.
 */
const MISMATCH_REASON = {
  memo: "invalid_exact_canton_memo_mismatch",
  synchronizer: "invalid_exact_canton_synchronizer_mismatch",
  receiver: "invalid_exact_canton_merchant_mismatch",
  instrument: "invalid_exact_canton_instrument_id_mismatch",
  amount: "invalid_exact_canton_amount_mismatch",
} as const satisfies Record<
  NonNullable<ReturnType<typeof findTransferMismatch>>,
  SpecVerifyInvalidReason
>;

/** The fields Rule 2 calls the proof. */
const PROOF_FIELDS = ["preparedTransaction", "preparedTxHash", "signature"] as const;

/**
 * The pure canton-exact verification, factored out of the facilitator's
 * `V2CantonExact.verify`. Runs the stateless checks in order; the facilitator's
 * stateful checks (replay, min-amount FX policy) and the on-chain execute
 * compose on top of a successful result here.
 */
async function verifyCantonExact(
  networkId: NetworkId,
  payload: X402PaymentPayload<unknown, unknown>,
  requirements: X402PaymentRequirements<unknown>,
): Promise<VerifyResponse> {
  // 1. scheme — the requirements the payer chose (`accepted`) and the ones it
  //    is verified against must both name the one id the spec defines (Rule 1).
  //    A payment with no `accepted`, or a pre-spec envelope that carries the
  //    scheme at the top level instead, names none.
  const accepted = isObj(payload.accepted) ? payload.accepted : undefined;
  if (payload.x402Version !== 2) return fail("invalid_x402_version", "internal_error");
  if (!accepted) return fail("unsupported_scheme", "scheme_mismatch");
  if (accepted.scheme !== EXACT_SCHEME_ID || requirements.scheme !== EXACT_SCHEME_ID) {
    return fail("unsupported_scheme", "scheme_mismatch");
  }
  // 2. network — accepted, requirements, and this verifier's binding must agree
  if (accepted.network !== requirements.network || requirements.network !== networkId) {
    return fail("invalid_network", "network_mismatch");
  }
  // 3. shapes — narrow the unknown inner/requirements before reading fields.
  //    `assetTransferMethod` is the same literal in both schemas, so once both
  //    pass, the payload's method and the requirements' agree.
  if (!isCantonPaymentRequirements(requirements)) {
    return fail("invalid_payment_requirements", "internal_error");
  }
  if (!isObj(payload.payload)) return fail("invalid_exact_canton_missing_proof", "internal_error");
  const raw = payload.payload;
  // Rule 2: a proof that is not there is missing_proof, one that is there but
  // not well-formed is malformed_payload. The key is not in the spec's
  // payload, but nothing can be checked without it, so its absence is a
  // missing proof too. The checks keep the order they had, so
  // `extensions.reason` stays what this verifier answered before: the key
  // first, and an empty field left to the checks that refused it.
  if (typeof raw.publicKey !== "string" || !raw.publicKey) {
    return fail("invalid_exact_canton_missing_proof", "missing_public_key");
  }
  if (PROOF_FIELDS.some((field) => typeof raw[field] !== "string")) {
    return fail("invalid_exact_canton_missing_proof", "internal_error");
  }
  if (!isCantonPaymentInner(raw)) return fail("invalid_exact_canton_malformed_payload", "internal_error");
  const inner = raw;
  // 4. Gunzip exactly once: guarding, decoding and hashing all use these
  //    bytes. A member that is malformed or over either bound is as
  //    undecodable as a bad protobuf.
  const prepared = gunzipPreparedTransaction(inner.preparedTransaction);
  if (prepared === null) {
    return fail("invalid_exact_canton_malformed_payload", "transfer_mismatch", undefined, "undecodable");
  }
  const preparedBase64 = bytesToBase64(prepared);
  // 5. Bound and validate the graph before anything walks it: the decoder
  //    below, and the upstream recursive hasher after it.
  const graph = guardPreparedTransaction(preparedBase64);
  if (!graph.ok) {
    return fail(
      "invalid_exact_canton_malformed_payload",
      "invalid_prepared_transaction_structure",
      undefined,
      graph.reason,
    );
  }
  // 6. The signed transfer. Its sender is the payer (spec Rule 8): the payload
  //    names none, so every result from here on reports this one.
  const transfer = decodePreparedTransaction(preparedBase64);
  if (!transfer) {
    return fail("invalid_exact_canton_malformed_payload", "transfer_mismatch", undefined, "undecodable");
  }
  const payer = transfer.sender;
  // 7. public key well-formed (32-byte Ed25519). Malformed key bytes are
  //    indistinguishable from "no usable key" here → missing_public_key. A
  //    key that is not one cannot have signed, so the spec's code is
  //    signature_invalid.
  let derivedFingerprint: string;
  try {
    derivedFingerprint = fingerprintForPublicKey(inner.publicKey);
  } catch {
    return fail("invalid_exact_canton_signature_invalid", "missing_public_key", payer);
  }
  // 8. the key must be the sender's: its fingerprint must match the sender
  //    party's `::<fingerprint>` suffix. Without this, any key could sign a
  //    transfer that names another party as the sender.
  const partySuffix = payer.split("::")[1];
  if (!partySuffix || derivedFingerprint.toLowerCase() !== partySuffix.toLowerCase()) {
    return fail("invalid_exact_canton_signature_invalid", "bad_fingerprint", payer);
  }
  // 9. Validate the prepared-transaction hash and signature encodings.
  //    `signature` is canonical base64, while `preparedTxHash` is canonical
  //    lowercase hex. The hash is keyed on the facilitator's submissionId,
  //    so alternate spellings of the same bytes are refused.
  const signatureHex = signatureFromBase64(inner.signature);
  if (!PREPARED_TX_HASH.test(inner.preparedTxHash) || signatureHex === null) {
    return fail("invalid_exact_canton_signature_invalid", "bad_signature", payer);
  }

  // 10. An absent hashingSchemeVersion means V2. The spec answers one this
  //     verifier does not implement with malformed_payload.
  const hashingSchemeVersion =
    inner.hashingSchemeVersion ?? HashingSchemeVersion.V2;

  if (hashingSchemeVersion !== HashingSchemeVersion.V2) {
    return fail("invalid_exact_canton_malformed_payload", "internal_error", payer);
  }

  // 11. Derive the trusted hash from the validated prepared transaction.
  let computedHash: string;
  try {
    computedHash = await computePreparedTransactionHash(
      preparedBase64,
      hashingSchemeVersion,
    );
  } catch {
    return fail("invalid_exact_canton_malformed_payload", "transfer_mismatch", payer, "undecodable");
  }

  // 12. The supplied hash must describe this exact transaction (Rule 3, so
  //     signature_invalid in the spec's terms).
  if (computedHash.toLowerCase() !== inner.preparedTxHash.toLowerCase()) {
    return fail("invalid_exact_canton_signature_invalid", "prepared_transaction_hash_mismatch", payer);
  }

  // 13. Verify the payload's base64 signature against the trusted hash.
  if (!verifySignature(computedHash, signatureHex, inner.publicKey)) {
    return fail("invalid_exact_canton_signature_invalid", "bad_signature", payer);
  }

  // 14. The signed transfer must actually move what the requirements demand.
  //     This is the payload's one binding to the requirements: the signature
  //     covers the prepared transaction, so checking receiver/instrument/amount
  //     rejects a valid signature over a divergent transfer (e.g. to another
  //     party, or a smaller amount).
  const mismatch = findTransferMismatch(transfer, requirements);
  if (mismatch) return fail(MISMATCH_REASON[mismatch], "transfer_mismatch", payer, mismatch);
  // 15. the transfer must still be executable. An absent deadline counts as
  //     expired: `executeBefore` is not optional in a real transfer, and
  //     reading a missing one as "no deadline" would make the check skippable
  //     by leaving the field out.
  if (isTransferExpired(transfer.executeBeforeMicros)) {
    return fail("invalid_exact_canton_expired", "transfer_expired", payer);
  }
  return { isValid: true, payer };
}

/**
 * The transfer a payload's `preparedTransaction` authorizes: base64 of one gzip
 * member, gunzipped and decoded. `null` when it is malformed or over either
 * bound, which is as undecodable as a bad protobuf. Its `sender` is the
 * payment's payer (spec Rule 8), since the payload names none. Takes untrusted
 * input, so a value that is not a string is `null` too, not a throw.
 */
export function decodePayloadTransfer(preparedTransaction: string): DecodedTransfer | null {
  if (typeof preparedTransaction !== "string") return null;
  const prepared = gunzipPreparedTransaction(preparedTransaction);
  return prepared && decodePreparedTransaction(bytesToBase64(prepared));
}

/**
 * Check a decoded transfer against the requirements. Returns `null` when the
 * transfer satisfies them, or a short field detail (`"receiver" | "instrument" |
 * "amount" | "memo"`) naming the first divergence. The verifier answers with
 * the spec's code for that field, and the field in `extensions.detail`. The amount must be EQUAL,
 * not merely sufficient (Rule 4), and the two sides are in different units — the
 * transfer carries an on-ledger Decimal, the requirements an atomic integer at
 * the Token Standard's fixed scale.
 */
export function findTransferMismatch(
  transfer: DecodedTransfer,
  requirements: CantonPaymentRequirements,
): "receiver" | "instrument" | "amount" | "memo" | "synchronizer" | null {
  // No sender check: the sender is the payer by definition (spec Rule 8), and
  // the verifier has already bound the signing key to it by fingerprint.
  // Rule 12, both ways. The spec only requires the check when the merchant
  // quotes a memo, but `x402.memo` is a key the scheme reserves, not the
  // payer's own namespace — its own references go under its own key, which is
  // where the wallet SDK already writes them. So an unquoted transfer must
  // carry no memo either: a merchant that reconciles ledger payments by memo
  // would otherwise credit whichever order a payer chose to name, paying a
  // cheap resource to settle an expensive one.
  if (transfer.memo !== requirements.extra.memo) return "memo";
  // The domain the payer prepared for, from the signed block, so it is theirs
  // to commit. Without it a payment lands on whatever synchronizer the
  // transfer names, which need not be one the merchant settles on.
  if (!synchronizerMatches(transfer.synchronizerId, requirements.extra.synchronizerId)) {
    return "synchronizer";
  }
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
