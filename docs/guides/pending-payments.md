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
`settlement_pending`.

Once the transfer's deadline has passed, a retry is refused as
`invalid_exact_canton_expired` before any of this, and that answer says nothing
about the first payment: it may have committed. Through the Express middleware
the refusal comes with a fresh, payable challenge, like any other refusal. With
the default `executeBeforeSeconds` of 120, that is about two minutes after
signing. **Don't pay that challenge** until you know what became of the first
payment.

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
  the payment failed. Through the Express middleware a failed relay comes back
  as a `402` with a fresh challenge and
  `error: "invalid_exact_canton_execute_failed"` in the body, not in
  `PAYMENT-RESPONSE`; only then sign a new payment. If it keeps answering
  `settlement_pending`, take it up with the merchant, naming the transaction.
  After the deadline, see [above](#what-a-retry-tells-you).

### Keeping the header

`createX402Fetch` doesn't hand back the header it sent. To keep it, either build
the payment yourself, with `payer.authorize(requirements, { resource })` and
`encodePaymentHeader` from `@chainsafe/x402-core`, or give the wrapper a `fetch`
that records it. The paid request goes through the same `fetch`, carrying the
header:

```ts
let sent: string | undefined;

const pay = createX402Fetch(payer, {
  fetch: (input, init) => {
    sent = new Headers(init?.headers).get("PAYMENT-SIGNATURE") ?? sent;
    return fetch(input, init);
  },
});
```

## Calling the facilitator directly

`FacilitatorClient.settle` returns a pending answer as a value, not an error,
since the facilitator sends it with HTTP `200`. Settling the same payload again
is safe: it never submits twice, and it answers
`invalid_exact_canton_execute_failed` if the first relay was rejected. A payment
that keeps answering `settlement_pending` has to be confirmed on the ledger, by
its transaction.

`verify` answers a payment that was already relayed with `isValid: false` and
`invalidReason: "settlement_pending"`, naming the transaction and its network in
`extra.transaction` and `extra.network`. That is the same pending state, not a
refusal, and the Express middleware answers it as pending. `isSettlementPending`
reads only a settle answer, so check `invalidReason` on a verify answer.
