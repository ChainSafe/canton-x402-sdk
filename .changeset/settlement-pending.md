---
"@chainsafe/x402-core": minor
"@chainsafe/x402-express": minor
"@chainsafe/x402-server-sdk": minor
"@chainsafe/x402-client": patch
---

`settlement_pending` is no longer read as a failure. A facilitator answers it
when it relayed the transfer and could not read the outcome: the transfer may
still commit, so the payer must not be asked to pay again
(ChainSafe/canton-x402-facilitator#362).

- **core.** A settle failure can carry `transaction`, `network` and `payer`; a
  pending answer names its transfer in `transaction`. `isSettlementPending`
  recognises one, and `encodePaymentResponseHeader` /
  `decodePaymentResponseHeader` carry a settle answer in the `PAYMENT-RESPONSE`
  header.
- **express.** On a pending answer the middleware settles once more. If the
  outcome is still unknown, it answers 402 with the facilitator's answer in
  `PAYMENT-RESPONSE`, without serving the request and without a fresh
  challenge, and does not call `onReject`.
- **server-sdk.** `createX402Fetch` resends the same payment on a pending
  answer, up to 3 times, 2 seconds apart, and never signs a second one.
- **client.** `FacilitatorClient` returns a settle failure sent with 200,
  pending included, as a value; a failure sent with a 4xx still throws.
