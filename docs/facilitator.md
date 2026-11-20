---
description: The guarantees verify enforces before any money moves, and what settlement does on Canton.
---

# The facilitator

This page zooms in on steps 5 and 6 of [the payment flow](/payment-flow), the
facilitator's half. Before any money moves, verify checks that a payment was
not swapped for different terms, and it does not treat an in-flight transfer
as a failure. Settle re-runs those checks before executing on Canton. The
facilitator never moves a payer's funds on its own authority: the only write
that moves them is `executeAndWaitForTransaction` of a **payer-signed**
transaction.

## What verify guarantees

These run in order, with no chain write. The first seven are shared code — the
same `@chainsafe/x402-core` verifier the SDK exposes — so a payer can pre-flight
its payload against them, and they refuse with the Canton scheme spec's codes,
saying in `extensions.detail` which of a code's causes it was. The last is the
facilitator's alone, since only it holds the state involved:

1. **Right scheme and network** — the payload, the requirements, and the
   network this facilitator is bound to all agree (`unsupported_scheme` or
   `invalid_network` otherwise).
2. **The transaction decodes** — `preparedTransaction` is one gzip member
   within the size caps, its node graph is well-formed, and it holds the one
   transfer. Its sender is the payer (the payload names none), and checks 3 to
   6 report it. A payload missing its proof is
   `invalid_exact_canton_missing_proof`, and one that does not decode is
   `invalid_exact_canton_malformed_payload`.
3. **Still executable** — the signed transfer's own `executeBefore` is far
   enough in the future to settle (`invalid_exact_canton_expired`). The quote itself no
   longer expires; the deadline that counts is inside what the payer signed.
4. **The keys belong to the payer** — the payload carries none. The
   facilitator reads the sender party's signing keys from the ledger, by that
   party id, and it is the lookup that binds them to the payer, so a caller
   can't sign as a party it doesn't control
   (`invalid_exact_canton_signature_invalid` when none can be resolved).
5. **The signature is valid** — the hash recomputed from the transaction
   itself must equal `preparedTxHash`, and the payer's key must have signed it
   (`invalid_exact_canton_signature_invalid` otherwise).
6. **The signed transfer actually pays you.** This is what binds the payment to
   your terms: the transfer's receiver, instrument and amount are checked
   against the requirements, so a valid signature over a divergent transfer is
   rejected: `invalid_exact_canton_merchant_mismatch`,
   `invalid_exact_canton_instrument_id_mismatch`,
   `invalid_exact_canton_amount_mismatch` or
   `invalid_exact_canton_memo_mismatch`. The amount
   must be EQUAL, not merely sufficient — `exact` is the scheme's
   distinguishing property, and a payer who overpays has no refund path. The
   transfer's `x402.memo` must equal your `extra.memo` exactly — in both
   directions, so a transfer carrying a memo you did not quote is refused as
   well.
7. **The transfer went through a real factory** — the contract the transfer
   choice was exercised on must be one the transaction itself discloses,
   exercised through the Token Standard `TransferFactory` interface, and
   carrying the instrument's admin among its signatories
   (`invalid_exact_canton_malformed_payload`, with a `factory_` detail naming
   which part failed). Without it a payer could exercise a contract of their
   own that merely exposes a choice of the same name, and the payment would
   reduce to "something called transfer happened". The disclosure travels
   inside what the payer signed, so this check takes it on the payer's word;
   the synchronizer authenticates it against the contract id at submission,
   which is where a fabricated one fails.
8. **Submission state, and you're an allowed destination.** A transfer that
   has already settled names input holdings that are spent, and the ledger
   refuses it. A retry whose first relay is still unresolved is not that case:
   verify answers `settlement_pending`, with `extensions.detail` of
   `submission_replayed`, instead of asking for another signature. For an
   authenticated merchant, `payTo` must be a party that key is allowed to
   receive at. A destination denial comes back as
   `invalid_exact_canton_merchant_not_registered` with a
   `destination_not_allowed` detail, on verify and on settle alike.

## When a payment may still land

`settlement_pending` is non-terminal. It can arrive from verify, on a retry of
a transaction the facilitator has already submitted, or from settle, when the
relay went out and the ledger outcome is not known yet.

The buyer resends the same signed payment. It does not sign another one.
Express therefore answers `402` with `PAYMENT-RESPONSE` and no
`PAYMENT-REQUIRED`. `onReject` is not called, because nothing the merchant
reserved is yet known to need an undo.

A verify answer has no `transaction` or `network` field of its own. The
facilitator supplies them as `extra.transaction` and `extra.network`.
`extra.transaction` is the payment's `preparedTxHash`. On a successful settle,
the field named `transaction` means something else: the Canton update id. On a
pending settle it is again the `preparedTxHash`. Match on `errorReason` or
`invalidReason` before reading it.

## What settlement does

Funds are real Splice **Amulet** (Canton Coin), transferred through the Token
Standard's `TransferFactory` in one atomic Canton transaction. Your party must hold a live
`TransferPreapproval`: with one the transfer is direct, so nothing is escrowed
or locked up. Without one the Token Standard would make it an offer that
completes only once you accept it — which is not a payment the facilitator can
stand behind, since the resource is already served while the funds sit where
the payer can withdraw them. Such a payment is refused at verify, with
`invalid_exact_canton_preapproval_missing`. What is recorded is the signed transfer's amount, not
the quoted floor, so an overpayment is not understated.
