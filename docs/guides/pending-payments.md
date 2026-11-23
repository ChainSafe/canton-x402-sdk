---
description: What settlement_pending means, why it is not a failure, and what the merchant, the payer and a direct facilitator caller should each do with it.
---

# Pending payments

`settlement_pending` means the facilitator relayed the payer-signed transaction
to Canton but does not know yet whether it committed: the participant took it,
and then the answer was lost or slow. **It is not a failure.** The transaction
may still commit, and if it does the payer has paid. Treating it as a failure is
how a payer ends up paying twice.

## What a retry tells you

The facilitator remembers every transaction it relayed. Presenting the same
payment again, at verify or at settle, does not submit it again; it answers with
what the facilitator knows:

| The first relay…           | A retry of the same payment answers   |
| -------------------------- | ------------------------------------- |
| is still unresolved        | `settlement_pending`                  |
| committed                  | `settlement_pending`                  |
| was rejected by the ledger | `invalid_exact_canton_execute_failed` |

A retry can tell you a payment **failed**, so the payer can sign a new one. It
cannot tell you it succeeded: the spec forbids a facilitator from answering a
settle from a remembered commit, so a committed payment keeps answering
`settlement_pending`. Once the transfer's deadline has passed, a retry is
refused as `invalid_exact_canton_expired` before any of this.

The answer names the transaction, in `transaction` on settle and in
`extra.transaction` on verify. It is the payment's `preparedTxHash`, since there
is no update id until it commits.

## Merchants

The Express middleware answers a pending settlement with a `402` carrying only
`PAYMENT-RESPONSE`: no new challenge, so a client is not invited to pay again.
The request is not served, and `onReject` is not called, since nothing is owed
an undo.

The funds may still land at your party. If they do, serve or refund the order
out of band, matching it by the transaction hash or your `memo`.

## Payers

- **Do not sign a new payment** for a request answered `settlement_pending`. The
  first one may still move your funds.
- **Do not retry the request through `createX402Fetch`.** The wrapper sends one
  payment and returns what comes back; called again, it gets a fresh `402` and
  signs a second transfer.
- **Check it with `isSettlementPending`** from `@chainsafe/x402-core`, on the
  settle answer decoded from `PAYMENT-RESPONSE`
  (`decodePaymentResponseHeader`).
- Re-sending the **same** `PAYMENT-SIGNATURE` header is safe, and tells you if
  the payment failed. If it keeps answering `settlement_pending`, take it up
  with the merchant, naming the transaction.

## Calling the facilitator directly

`FacilitatorClient.settle` returns a pending answer as a value, not an error,
since the facilitator sends it with HTTP `200`. Settling the same payload again
is safe: it never submits twice, and it answers `invalid_exact_canton_execute_failed`
if the first relay was rejected. A payment that keeps answering
`settlement_pending` has to be confirmed on the ledger, by its transaction.
