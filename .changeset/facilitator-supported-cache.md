---
"@chainsafe/x402-client": minor
---

Cache `GET /v2/supported`, and stop typing verify/settle more narrowly than the
protocol.

`supported()` now reuses its answer for `supportedTtlMs` — default five minutes,
`0` to fetch every time. What the endpoint returns is what a deployment settles:
the (scheme, network) kinds and, in `kinds[].extra`, the synchronizer, the
instruments and the transfer methods. Those change when a facilitator is
redeployed, not per request, so a caller that configures from them should not
pay a round trip each time it wants to quote.

Three things the cache does beyond holding a value:

- **Concurrent callers share one request.** A cold start under load costs one
  round trip, not one per caller.
- **A failed refresh falls back to the last value.** A facilitator blip should
  not stop a merchant quoting terms that have not changed. With no previous
  value the error propagates as before.
- **A failure is not cached.** The next call retries.

`supported({ refresh: true })` bypasses it.

```ts
const facilitator = new FacilitatorClient(url, { apiKey, supportedTtlMs: 60_000 });
```

### verify/settle take the envelope types

```diff
- verify(payload: CantonPaymentPayload, requirements: CantonPaymentRequirements)
+ verify(payload: X402PaymentPayload<unknown>, requirements: X402PaymentRequirements<unknown>)
```

`/v2/verify` and `/v2/settle` are scheme-agnostic on the wire — the envelope is
`{x402Version, paymentPayload, paymentRequirements}` whatever the scheme — so the
client had no business accepting only canton-exact's concrete shapes. This is a
widening, so every existing call still compiles; it is what lets a scheme-generic
merchant middleware use the same client.
