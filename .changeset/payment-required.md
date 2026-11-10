---
"@chainsafe/x402-core": major
"@chainsafe/x402-express": minor
---

A 402 now carries the spec's `PaymentRequired`.

`@chainsafe/x402-express` sends it base64-encoded in a `PAYMENT-REQUIRED`
header, where the x402 v2 HTTP transport puts it, and adds its top-level
`resource` to the body: the URL and description the requirements were quoted
for, the same values each `accepts[]` entry carries. The body keeps its other
fields, `details` included, so existing clients keep working.

**Breaking, in core:** `X402PaymentRequiredResponse` and
`CantonPaymentRequiredResponseSchema` require `resource`, a `ResourceInfo` with
a `url`, as the spec does, and take an optional `extensions`. New:
`encodePaymentRequiredHeader`, and `isCantonPaymentRequiredResponse` to check a
402 against the schema.
