// The canton-exact scheme verifier — scheme `exact` on a `canton:*` network.
//
// This file is the ORDER a payment is checked in. What each step checks
// against lives elsewhere: Ed25519 verification in ./primitives (the key
// fingerprint is NOT used here any more — see step 7-8), the binding to the
// merchant's quote in
// ./transfer-binding, the factory and delivery rules in ./transfer-rules, and
// the canton-payload shape guards in ../types. Pure and stateless — the
// stateful guards (replay) and on-chain execution stay in the facilitator,
// which composes this verifier's result.

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
 * The hash and signature are canonically encoded, the hashing scheme is one
 * this verifier implements, the hash is recomputed from the bytes rather than
 * trusted, and the signature holds against a key the SENDER publishes. No key
 * is checked here — the caller resolved them by party id, and that lookup is
 * what makes them the sender's. Refuses or passes; it reads nothing out for
 * the caller.
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
  payerPublicKeys: readonly string[],
): Promise<VerifyResponseInvalid | null> {
  // 7-8. There is no key to check here any more. The payload carries none — the
  //      spec's never did — and the ones the caller passes were read from the
  //      ledger BY PARTY ID, so that lookup is what binds them to the sender and
  //      there is nothing left for this verifier to re-derive. The fingerprint
  //      check that used to live here existed because the key arrived inside the
  //      payload, chosen by whoever sent it.
  //
  //      Deliberately NOT narrowed to the key whose fingerprint equals the
  //      sender's `::` suffix: that suffix is the party's NAMESPACE fingerprint,
  //      which equals the signing key's only for a single-key party. One
  //      mid-rotation publishes two, and narrowing would refuse the honest
  //      payment that the other one signed.
  if (payerPublicKeys.length === 0) {
    return fail("invalid_exact_canton_signature_invalid", "missing_public_key", payer);
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

  // 13. Verify the payload's base64 signature against the trusted hash, under ANY
  //     key the party publishes: the payload does not say which one signed, and
  //     any of them verifying is the party verifying. `verifySignature` answers
  //     false rather than throwing, so bytes that are not a usable key are simply
  //     not the one that signed.
  if (!payerPublicKeys.some((key) => verifySignature(computedHash, signatureHex, key))) {
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
  // not well-formed is malformed_payload. The payer's key is no longer among the
  // fields checked here — the spec's payload never had one, and it now comes
  // from the party's topology instead (#105), so its absence is the caller's to
  // answer and not a malformed payload.
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
  payerPublicKeys: readonly string[],
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
  const proof = await checkProof(inner, payer, preparedBase64, payerPublicKeys);
  if (proof) return proof;
  // 14. The signed transfer must actually move what the quote demands.
  //     This is the payload's one binding to the quote: the signature
  //     covers the prepared transaction, so checking receiver/instrument/amount
  //     rejects a valid signature over a divergent transfer (e.g. to another
  //     party, or a smaller amount).
  const violation = transferViolation(transfer, quoted);
  if (violation) return fail(VIOLATION_REASON[violation], "transfer_mismatch", payer, violation);
  // 15. the exercise must go through a real transfer factory, proved from the
  //     transaction's own input contracts. Placed after 14 because it reads
  //     the admin that step has just held equal to the quote's, so the
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
    verify: (payload, requirements, payerPublicKeys) =>
      verifyCantonExact(networkId, payload, requirements, payerPublicKeys),
  };
}
