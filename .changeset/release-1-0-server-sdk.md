---
"@chainsafe/x402-server-sdk": major
---

**Pays requirements of the [Canton `exact` scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_canton.md), over the x402 v2 [HTTP transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md).** Breaking: the payment is the spec's payload, so the merchant must be on `@chainsafe/x402-express` 1.0 or another v2 server. Requires Node 22.2 or later.

- `createX402Fetch` sends the payment in `PAYMENT-SIGNATURE` instead of `X-PAYMENT`, and reads the offer from the `PAYMENT-REQUIRED` header.
- A 402 whose `PAYMENT-RESPONSE` is `settlement_pending` (`isSettlementPending`) may still land: don't retry it through `createX402Fetch`, which signs a new payment.
- `CantonPartyKey` no longer takes `publicKey`: pass `{ partyId, privateKey }`. The facilitator reads the key from the ledger.
- A custom `X402Payer.authorize` receives the 402's `resource` as a second argument (`PaymentContext`).
- The `VERSION` export, which always read `0.0.1`, is removed.
