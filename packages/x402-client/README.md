# @chainsafe/x402-client

Client for a Canton [x402](https://x402.org) facilitator: call `verify`,
`settle` and `supported` over HTTP. Depends only on
[`@chainsafe/x402-core`](../x402-core) for the wire types. Ships dual ESM + CJS.

## Install

```bash
npm install @chainsafe/x402-client
```

## Usage

```ts
import { FacilitatorClient } from "@chainsafe/x402-client";

// Construct once (Authorization: Bearer <apiKey>) and reuse.
const facilitator = new FacilitatorClient(process.env.FACILITATOR_URL!, {
  apiKey: process.env.FACILITATOR_API_KEY!,
});

const kinds = await facilitator.supported(); // cached for supportedTtlMs (5 min)
const verdict = await facilitator.verify(paymentPayload, paymentRequirements);
const settled = await facilitator.settle(paymentPayload, paymentRequirements);
```

For gating an Express route behind a payment, use
[`@chainsafe/x402-express`](../x402-express).

## Documentation

- [Facilitator client](https://chainsafe.github.io/canton-x402-sdk/guides/facilitator-client.html): which requirements to send, answers and errors, the `supported()` cache
- [Facilitator HTTP API](https://chainsafe.github.io/canton-x402-sdk/reference/http-api.html) and [Error codes](https://chainsafe.github.io/canton-x402-sdk/reference/error-codes.html)

## License

Apache-2.0
