---
description: Call a facilitator's verify, settle and supported from code with FacilitatorClient — when you are not using the Express middleware.
---

# Facilitator client

`FacilitatorClient` from `@chainsafe/x402-client` calls a facilitator's
`/v2/verify`, `/v2/settle` and `/v2/supported`. The Express middleware uses it
for you; call it yourself to verify and settle from another server framework,
or to drive settlement from a backend. The
[HTTP API reference](/reference/http-api) describes the endpoints underneath.

```bash
npm install @chainsafe/x402-client
```

```ts
import { FacilitatorClient } from "@chainsafe/x402-client";

// Construct once (it sends Authorization: Bearer <apiKey>) and reuse.
const facilitator = new FacilitatorClient(process.env.FACILITATOR_URL!, {
  apiKey: process.env.FACILITATOR_API_KEY!,
});

const kinds = await facilitator.supported();
const verdict = await facilitator.verify(paymentPayload, paymentRequirements);
const settled = await facilitator.settle(paymentPayload, paymentRequirements);
```

`paymentPayload` and `paymentRequirements` are the wire types from
`@chainsafe/x402-core`.

## Which requirements to send

Verify and settle against the requirements the payment was built for, its
`accepted`, but **only after checking them against your own terms**: they are
not signed, so a payer can echo anything. Compare at least the scheme, network,
`payTo`, instrument and amount with what you quote, as the Express middleware
does. The facilitator then holds the signed transfer to those requirements.

## Answers and errors

- **`verify`** resolves with the verdict, `isValid` true or false; a refusal
  carries `invalidReason` and `extensions.detail`. One `isValid: false` is not a
  refusal: `invalidReason: "settlement_pending"` means the payment was already
  relayed and may still commit, with the transaction in `extra.transaction`.
  Don't ask for a new payment. `isSettlementPending` takes only a settle answer,
  so check `invalidReason` here.
- **`settle`** resolves with the outcome on any `2xx`, `success` true or false.
  The facilitator answers `settlement_pending` and its other relay outcomes with
  `200`, so they arrive as values. `settlement_pending` is not a failure: check
  it with `isSettlementPending` from `@chainsafe/x402-core`, and see
  [Pending payments](/guides/pending-payments).
- **Any other status throws** a `FacilitatorError` carrying the HTTP `status`
  (`0` for a network failure or timeout), the response body, and the
  `Retry-After` value when there is one. A refusal before anything was relayed
  is a `400`, so it throws.

[Error codes](/reference/error-codes) lists every reason code.

## `supported()` and its cache

`supported()` returns what the facilitator settles: its `(scheme, network)`
kinds, and in `kinds[].extra` the synchronizer, fee payer and instruments.

The answer is cached for `supportedTtlMs` (5 minutes by default). Concurrent
callers share one request, and a refresh that fails falls back to the last
answer rather than stopping you quoting. `supported({ refresh: true })` skips
the cache.
