---
"@chainsafe/x402-express": patch
---

A payment that may still land is never answered with a fresh challenge, which
would have the payer sign a second transfer while the first may commit.

- A `settlement_pending` answer from **verify** (a facilitator that has seen
  the signed transaction before, on a retry) is answered as pending, as one
  from settle is: a 402 with only `PAYMENT-RESPONSE`. A verify answer has no
  field for the transaction or its network, so the facilitator names them in
  `extra.transaction` and `extra.network`, and the middleware passes them on
  as given.
- `onReject` receives a failed settle's `extensions`, as it does a verify
  refusal's.
