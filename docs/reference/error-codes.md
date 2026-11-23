---
description: Every reason code the facilitator answers verify and settle with, what it means, and what to do about it.
---

# Error codes

A refused verify answers `isValid: false` with the code in `invalidReason`; a
failed settle answers `success: false` with it in `errorReason`. Both use one
vocabulary: the codes the [Canton `exact` scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_canton.md)
and [x402 v2](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)
define, plus one of this implementation's own, marked below. Match on the code.

`extensions.detail`, when present, says which of a code's causes it was, where
the code alone leaves two apart. `invalidMessage` and `errorMessage` are free
text for logs and people: they change between releases, so never match on them.

## The payment does not match

The signed transfer is not the payment you asked for. Nothing was submitted, and
the same payload will be refused again: the payer has to build a new payment.

- `invalid_exact_canton_amount_mismatch`: The transfer moves a different amount from `amount`. The amount must be equal, not merely enough.
- `invalid_exact_canton_merchant_mismatch`: The transfer pays someone other than `payTo`.
- `invalid_exact_canton_instrument_id_mismatch`: The transfer moves a different instrument from `extra.instrumentId`, or the facilitator does not settle that instrument (detail `unserved_instrument`).
- `invalid_exact_canton_memo_mismatch`: The transfer's `x402.memo` differs from `extra.memo`, or carries one you did not quote.
- `invalid_exact_canton_expired`: The transfer's own deadline (`executeBefore`) is past, or under 5 seconds away.
- `invalid_exact_canton_preapproval_missing`: The transfer would not land directly at `payTo`, which needs a live `TransferPreapproval`. Without one it becomes an offer the merchant must accept, which the facilitator refuses to relay.
- `invalid_exact_canton_insufficient_inputs`: The holdings the transfer spends are missing, repeated, or do not cover the amount.
- `invalid_exact_canton_synchronizer_mismatch`: **This implementation's own.** The transfer was prepared on a different synchronizer from `extra.synchronizerId`. The spec defines no code for it; another facilitator may answer `invalid_exact_canton_malformed_payload`.
- `invalid_exact_canton_self_payment`: The payer is the facilitator's own party.

## The payment is not well-formed

- `invalid_exact_canton_missing_proof`: The payload is missing `preparedTransaction`, `preparedTxHash` or `signature`.
- `invalid_exact_canton_malformed_payload`: The proof does not decode, or is not one transfer through the instrument's real `TransferFactory`. The detail names the part: `undecodable` (it will not gunzip), `structure_undecodable` (it gunzips but cannot be read), `payload_shape`, `unsupported_hashing_scheme`, or a `factory_` detail.
- `invalid_exact_canton_signature_invalid`: The signature does not prove the payer signed this transaction: `no_payer_key` (the party publishes no key the facilitator can use), `malformed_encoding` (the hash or signature is not in the spec's encoding), `hash_mismatch` (the hash describes a different transaction) or `bad_signature` (it verifies under none of the party's keys).

## The requirements are wrong

The merchant's side needs fixing, not the payer's.

- `invalid_payload`: The body is not an x402 v2 request: `{ x402Version: 2, paymentPayload, paymentRequirements }`, with `paymentPayload.accepted` a whole set of requirements. Answered with HTTP `400`.
- `unsupported_scheme`: The scheme is not `exact`.
- `invalid_network`: The payment's network differs from the requirements', or is not the network this facilitator settles.
- `invalid_payment_requirements`: The requirements are malformed (for example an `instrumentId` without its `admin`, or an amount that is not atomic units), or a settle reuses an `extra.memo` this project has already settled under (detail `memo_already_used`).
- `invalid_exact_canton_fee_payer_mismatch`: `extra.feePayer` is not this facilitator's party. Take it from [`GET /v2/supported`](/reference/http-api#get-v2-supported).
- `invalid_exact_canton_merchant_not_registered`: Your API key may not receive at `payTo` (detail `destination_not_allowed`): `payTo` must be a party your project owns.

## Settlement outcomes

- `settlement_pending`: **Not a failure.** The transaction was relayed and its outcome is not known yet. `transaction` names it. **What to do:** Do not ask for a new payment. Retrying the same payload is safe and answers `invalid_exact_canton_execute_failed` if the relay failed, but keeps answering `settlement_pending` even once it commits. A verify of a payment already relayed answers the same way, with the transaction in `extra`. See [Pending payments](/guides/pending-payments).
- `invalid_exact_canton_execute_failed`: The ledger rejected the transaction. Also the answer to a replay of one that failed. **What to do:** The payer builds a new payment.

## Faults

- `unexpected_canton_ledger_error`: The facilitator could not read the ledger: the payer's keys (detail `payer_keys_unavailable`) or the ledger's position before submitting (`ledger_end_unavailable`). Nothing was submitted. **What to do:** Retry the same payload.
- `unexpected_verify_error`: A fault in the facilitator during verify. HTTP `500`. **What to do:** Retry.
- `unexpected_settle_error`: A fault during settle. HTTP `500`, or `503` with `Retry-After` and detail `capacity_exhausted` when the facilitator is out of ledger capacity for the day, in which case nothing was submitted. **What to do:** Retry the same payload, after `Retry-After` if given.

## Defined but not answered

The specs also define `invalid_exact_canton_execute_before_too_far`,
`insufficient_funds`, `invalid_scheme`, `invalid_transaction_state` and
`invalid_x402_version`. The SDK accepts them in an answer, but this facilitator
does not send them: a body whose `x402Version` is not `2` is `invalid_payload`,
and a payer without the funds cannot sign a transfer to begin with.
