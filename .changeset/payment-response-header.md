---
"@chainsafe/x402-express": major
---

**Breaking. The settle answer travels in `PAYMENT-RESPONSE`, and
`X-PAYMENT-RESPONSE` is gone.**

`PAYMENT-RESPONSE` is the header the x402 v2 HTTP transport names for a settle
answer.

- On a successful settle, `PAYMENT-RESPONSE` carries the facilitator's whole
  answer (`success`, `transaction`, `network`, and `payer` when it names one),
  base64-encoded JSON. `decodePaymentResponseHeader` from `@chainsafe/x402-core`
  reads it.
- A failed settle sends its answer in `PAYMENT-RESPONSE` too, on the 402 beside
  the fresh challenge, so a payer can read why it failed. A refusal before
  settle sends no `PAYMENT-RESPONSE`, since nothing was settled.
- `X-PAYMENT-RESPONSE`, the bare ledger transaction id this middleware sent
  before, is no longer sent. A client that read it reads `transaction` from the
  decoded `PAYMENT-RESPONSE` instead:

  ```ts
  const header = res.headers.get("PAYMENT-RESPONSE");
  const answer = header ? decodePaymentResponseHeader(header) : undefined;
  const updateId = answer?.success ? answer.transaction : undefined;
  ```

A browser client on another origin needs `PAYMENT-RESPONSE` in
`Access-Control-Expose-Headers` to read it.
