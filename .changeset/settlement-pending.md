---
"@chainsafe/x402-core": minor
"@chainsafe/x402-express": minor
"@chainsafe/x402-client": patch
---

`settlement_pending` is no longer read as a failure. A facilitator answers it
when it relayed the transfer and could not read the outcome: the transfer may
still commit, so the payer must not be asked to pay again
(ChainSafe/canton-x402-facilitator#362).

- **core.** A settle failure carries `transaction` and `network`, and can
  carry `payer`; a pending answer names its transfer in `transaction`, and its
  `network`. `isSettlementPending` recognises one, and
  `encodePaymentResponseHeader` / `decodePaymentResponseHeader` carry a settle
  answer in the `PAYMENT-RESPONSE` header.
- **express.** On a pending answer the middleware answers 402 with the
  facilitator's answer in `PAYMENT-RESPONSE`, without serving the request,
  without a fresh challenge, and without calling `onReject`. It does not settle
  again: that waits for a facilitator that can look a pending submission up.
- **client.** `FacilitatorClient` returns a settle failure sent with 200,
  pending included, as a value; a failure sent with a 4xx still throws.
