// What the signed transfer must SAY, as against what its tree must DO.
//
// `transferViolation` compares the transfer the payer signed with the quote
// the merchant published — memo, synchronizer, receiver, instrument, amount,
// in that order — and names the first field that disagrees. The deadline is
// not one of them: it is held against the clock rather than the quote, so it
// lives with the pipeline in `canton-exact.ts`. The delivery and factory rules
// in `transfer-rules.ts` ask the other question: not whether the transfer
// describes the right payment, but whether the transaction actually performs
// it.
//
// `VIOLATION_REASON` is deliberately NOT here. It maps a field name to a WIRE
// reason code, which is the pipeline's concern; keeping it there is what stops
// this module knowing anything about responses. Its `satisfies
// Record<TransferViolation, ...>` makes the compiler hold that map total
// across the import, so a member added here without a code fails to build.
//
// SPDX-License-Identifier: Apache-2.0

import type { CantonPaymentRequirements } from "../types/requirements";
import { isValidAmount, ledgerToAtomic, WIRE_DECIMALS } from "./common";
import type { DecodedTransfer } from "./prepared-tx";

/**
 * What distinguishes the PHYSICAL synchronizer id from the LOGICAL one in
 * `Metadata.synchronizer_id`: `<protocol-version>-<serial>`. Both are the
 * synchronizer's own, not the participant's — the protocol version is fixed
 * when it is initialised, the serial steps on a logical upgrade. Two decimal
 * runs, one hyphen, nothing else.
 */
const PHYSICAL_SYNCHRONIZER_SUFFIX = /^[0-9]+-[0-9]+$/;

/**
 * Is the signed synchronizer id the one the merchant quoted?
 *
 * `prepare` takes the logical id and refuses the physical one, and the bytes
 * it returns carry EITHER form depending on the Canton release — the logical
 * id on what LocalNet runs, the physical one on newer releases. So both are
 * taken: exact equality would refuse every honest payment from the latter.
 *
 * A suffixed match is not a weakening: the `1220…` is the domain's namespace
 * fingerprint, so `<quoted>::<n>-<m>` is provably the same domain at some
 * protocol version and serial. Another name, another fingerprint, a
 * non-numeric or three-part suffix, or any trailing text is refused, and an
 * absent id counts as a mismatch.
 */
export function isSameSynchronizer(signed: string | undefined, quoted: string): boolean {
  if (signed === undefined) return false;
  if (signed === quoted) return true;
  if (!signed.startsWith(`${quoted}::`)) return false;
  return PHYSICAL_SYNCHRONIZER_SUFFIX.test(signed.slice(quoted.length + 2));
}


/**
 * Which quoted field a transfer fails, **in the order they are checked**.
 *
 * The order is observable, not incidental: the check short-circuits, and the
 * caller turns the answer into both an `invalidReason` and the wire's
 * `extensions.detail`, which tests assert by name. A transfer that disagrees on
 * two fields is answered for whichever `if` in `transferViolation` runs first,
 * so reordering those changes what a client sees for an unchanged payment. The
 * members below are kept in that same order to record it — the union itself is
 * type-level, and reordering it alone changes nothing.
 */
export type TransferViolation =
  | "memo"
  | "synchronizer"
  | "receiver"
  | "instrument"
  | "amount";

/**
 * Check a decoded transfer against the requirements. Returns `null` when the
 * transfer satisfies them, or a short field detail naming the first divergence
 * — one of {@link TransferViolation}. The verifier answers with the spec's code
 * for that field, and the field itself in `extensions.detail`. The amount must
 * be EQUAL, not merely sufficient (Rule 4), and the two sides are in different
 * units — the transfer carries an on-ledger Decimal, the requirements an atomic
 * integer at the Token Standard's fixed scale.
 */
export function transferViolation(
  transfer: DecodedTransfer,
  requirements: CantonPaymentRequirements,
): TransferViolation | null {
  // No sender check: the sender is the payer by definition (spec Rule 8), and the
  // signing key is already bound to it — not by anything this verifier checks,
  // but because the caller resolved the party's keys from the ledger BY that
  // party id, and one of them verified.
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
  if (!isSameSynchronizer(transfer.synchronizerId, requirements.extra.synchronizerId)) {
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
