// The canton-exact scheme verifier + its Canton-specific primitives — that is,
// scheme `exact` on a `canton:*` network. Composes the scheme-agnostic checks in
// ./common with Ed25519 signature verification, the Canton key-fingerprint
// derivation, and the canton-id / canton-payload shape guards. Pure and
// stateless — the stateful guards (replay) and on-chain execution stay in
// the facilitator, which composes this verifier's result.

import type { NetworkId } from "../types/common";
import { CantonPaymentInner, HashingSchemeVersion, isCantonPaymentInner } from "../types/payment";
import { CantonPaymentRequirements, isCantonPaymentRequirements } from "../types/requirements";
import type {
  SchemeVerifier,
  VerifyInvalidReason,
  CantonExactExtensionReason,
  SpecVerifyInvalidReason,
  VerifyResponse,
  VerifyResponseInvalid,
} from "../types/facilitator";
import type { X402PaymentPayload } from "../types/payment";
import type { X402PaymentRequirements } from "../types/requirements";
import { decodePreparedTransaction, type DecodedTransfer } from "./prepared-tx";
import { gunzipPreparedTransaction } from "./prepared-tx-codec";
import { computePreparedTransactionHash } from "./prepared-tx-hash";
import { guardPreparedTransaction } from "./prepared-tx-guard";
import { transferViolation, type TransferViolation } from "./transfer-binding";
import {
  deliveryViolation,
  factoryViolation,
  senderSignedCreateViolation,
} from "./transfer-rules";
import {
  bytesToBase64,
  fingerprintForPublicKey,
  PREPARED_TX_HASH,
  signatureFromBase64,
  verifySignature,
} from "./primitives";


/**
 * The scheme identifier on the wire, defined by the registered Canton scheme spec
 * (`specs/schemes/exact/scheme_exact_canton.md`). Exported so the facilitator
 * reads it from here rather than repeating the literal.
 */
export const EXACT_SCHEME_ID = "exact";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
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

/**
 * A refusal. `invalidReason` is the spec's code, the one a client written
 * against the spec matches on. `extensions.reason` is the code this verifier
 * answered with before, kept beside it until those are dropped, and
 * `extensions.detail` says what diverged where there is more to say.
 */
function fail(
  invalidReason: VerifyInvalidReason,
  // Named apart from `invalidReason` because the two are the SAME type and sit
  // next to each other: transposing them at a call site compiles and changes
  // the wire response. The name is all that distinguishes them here.
  extensionReason: VerifyInvalidReason,
  payer?: string,
  detail?: string,
): VerifyResponseInvalid {
  return {
    isValid: false,
    invalidReason,
    ...(payer ? { payer } : {}),
    extensions: { reason: extensionReason, ...(detail !== undefined ? { detail } : {}) },
  };
}

/**
 * The code for each field {@link transferViolation} can name.
 *
 * Typed to the spec's table plus this scheme's own extensions, and nothing
 * else: `VerifyInvalidReason` also admits our protocol-level codes, and one of
 * them sat here answering the synchronizer — a slot no spec-written client
 * would have matched. The synchronizer still answers an extension, because the
 * spec defines no code for it; the type now says so rather than filing it
 * under the spec's.
 */
const VIOLATION_REASON = {
  memo: "invalid_exact_canton_memo_mismatch",
  synchronizer: "invalid_exact_canton_synchronizer_mismatch",
  receiver: "invalid_exact_canton_merchant_mismatch",
  instrument: "invalid_exact_canton_instrument_id_mismatch",
  amount: "invalid_exact_canton_amount_mismatch",
} as const satisfies Record<
  TransferViolation,
  SpecVerifyInvalidReason | CantonExactExtensionReason
>;

/** The fields Rule 2 calls the proof. */
const PROOF_FIELDS = ["preparedTransaction", "preparedTxHash", "signature"] as const;

/**
 * Steps 7-13: does the payer's own key prove this exact transaction?
 *
 * The key is well-formed and is the SENDER's, the hash and signature are
 * canonically encoded, the hashing scheme is one this verifier implements, the
 * hash is recomputed from the bytes rather than trusted, and the signature
 * holds against it. Refuses or passes; it reads nothing out for the caller.
 *
 * EVERY REFUSAL HERE NAMES THE PAYER, where steps 1-6 name nobody: the payer is
 * the transfer's sender and is known by the time this runs. Tests pin the exact
 * key set of both shapes, so a check moved across that boundary changes the
 * wire response even though the rule is unchanged.
 */
async function checkProof(
  inner: CantonPaymentInner,
  payer: string,
  preparedBase64: string,
): Promise<VerifyResponseInvalid | null> {
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

  return null;
}

/**
 * Steps 1-3: is this envelope one this verifier can read at all?
 *
 * Scheme, network, and the two shape narrowings — the payload's inner proof
 * and the requirements. Returns a refusal, or the two narrowed values the rest
 * of the pipeline reads fields off.
 *
 * NO PAYER IS REPORTED BY ANY REFUSAL HERE, and that is observable: the payer
 * is the transfer's sender, which is not known until step 6 decodes it, and
 * tests pin the exact key set of these responses. Nothing that learns the
 * payer may move into this stage, and nothing here may move after it.
 */
function checkEnvelope(
  networkId: NetworkId,
  payload: X402PaymentPayload<unknown, unknown>,
  requirements: X402PaymentRequirements<unknown>,
): VerifyResponseInvalid | { inner: CantonPaymentInner; requirements: CantonPaymentRequirements } {
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
  return { inner: raw, requirements };
}

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
  const envelope = checkEnvelope(networkId, payload, requirements);
  if ("isValid" in envelope) return envelope;
  // Bound to new names: the narrowings `checkEnvelope` performed do not reach
  // back across the call, so the rest of the pipeline reads these.
  const { inner, requirements: quoted } = envelope;
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
  // 7-13. the payer's own key must prove this exact transaction.
  const proof = await checkProof(inner, payer, preparedBase64);
  if (proof) return proof;
  // 14. The signed transfer must actually move what the quoted demand.
  //     This is the payload's one binding to the quoted: the signature
  //     covers the prepared transaction, so checking receiver/instrument/amount
  //     rejects a valid signature over a divergent transfer (e.g. to another
  //     party, or a smaller amount).
  const violation = transferViolation(transfer, quoted);
  if (violation) return fail(VIOLATION_REASON[violation], "transfer_mismatch", payer, violation);
  // 15. the exercise must go through a real transfer factory, proved from the
  //     transaction's own input contracts. Placed after 14 because it reads
  //     the admin that step has just held equal to the quoted', so the
  //     two cannot disagree about which instrument this is.
  const factory = factoryViolation(transfer);
  if (factory) return fail("invalid_exact_canton_malformed_payload", "transfer_mismatch", payer, factory);
  // 15b. no contract the SENDER signs may be created without the instrument's
  //      admin on it. Such a contract hands the payer's authority to whoever
  //      controls its choices, and nothing else here would notice: the quoted
  //      payment can be delivered perfectly while it is left behind.
  const created = senderSignedCreateViolation(transfer);
  if (created) return fail("invalid_exact_canton_malformed_payload", "transfer_mismatch", payer, created);
  // 16. the transfer must DELIVER, not leave a pending instruction. Which of
  //     the two a signed TransferFactory_Transfer does is visible only in its
  //     consequences, and relaying a pending one commits the payer's funds
  //     without paying the merchant.
  const delivery = deliveryViolation(transfer, quoted);
  if (delivery) {
    return fail("invalid_exact_canton_preapproval_missing", "transfer_mismatch", payer, delivery);
  }
  // 17. the transfer must still be executable. An absent deadline counts as
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
