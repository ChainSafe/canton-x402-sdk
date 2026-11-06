# @chainsafe/x402-client

Chain-agnostic client for a Canton [x402](https://x402.org) facilitator — call
`verify`, `settle`, and `supported` over HTTP. Depends only on
[`@chainsafe/x402-core`](../x402-core) for the wire types. Ships dual ESM + CJS.

## Install

```bash
npm install @chainsafe/x402-client
```

## Usage

```ts
import { FacilitatorClient } from "@chainsafe/x402-client";

// Construct once (Authorization: Bearer <apiKey>) and reuse.
const facilitator = new FacilitatorClient("https://x402.example.com", {
  apiKey: process.env.FACILITATOR_API_KEY!,
});

// Is a payment valid against its requirements? These are normally the payment's
// own `accepted`, once checked against your terms (the express middleware does).
const result = await facilitator.verify(paymentPayload, paymentRequirements);

// Which (scheme, network) pairs does this facilitator support?
const kinds = await facilitator.supported();

// Settle a verified payment on-ledger.
const settled = await facilitator.settle(paymentPayload, paymentRequirements);
```

`paymentPayload` / `paymentRequirements` are the wire types from
[`@chainsafe/x402-core`](../x402-core). For gating an Express route behind a
payment, see [`@chainsafe/x402-express`](../x402-express).

## License

Apache-2.0
