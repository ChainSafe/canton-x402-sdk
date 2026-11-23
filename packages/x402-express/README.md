# @chainsafe/x402-express

Express middleware for [x402](https://x402.org) payments on the Canton Network.
`paymentRequired()` gates a route: it answers `402 Payment Required` with the
terms when a request is unpaid, verifies the payment against a facilitator
(optionally settling it on-ledger), and lets paid requests through with the
verified payer attached to `req.x402`.

Depends only on [`@chainsafe/x402-core`](../x402-core) (wire types) and
[`@chainsafe/x402-client`](../x402-client) (the facilitator client). Ships dual
ESM + CJS, so it works in both `import` and classic `require()` Express apps.

## Install

```bash
npm install @chainsafe/x402-express @chainsafe/x402-client express
```

## Usage

```ts
import express from "express";
import { FacilitatorClient } from "@chainsafe/x402-client";
import { paymentRequired } from "@chainsafe/x402-express";

const app = express();

const facilitator = new FacilitatorClient(process.env.FACILITATOR_URL!, {
  apiKey: process.env.FACILITATOR_API_KEY!,
});

app.use(
  "/paid",
  paymentRequired({
    facilitator,
    settle: true,
    requirements: {
      payTo: "merchant::1220…",
      accepts: [{ amount: "500000000", asset: "Amulet" }], // 0.05 CC
    },
  }),
);

app.get("/paid", (req, res) => {
  res.json({ message: "Thanks!", payer: req.x402!.payer });
});
```

## Documentation

- [Accept payments](https://chainsafe.github.io/canton-x402-sdk/get-started/accept-payments.html): from a fresh account to a paid route
- [Express middleware](https://chainsafe.github.io/canton-x402-sdk/guides/express-middleware.html): every option, several ways to pay, memos and `preSettle`, `req.x402`, and gating on another scheme
- [Pending payments](https://chainsafe.github.io/canton-x402-sdk/guides/pending-payments.html): what a `settlement_pending` answer means for your route
- [Networks](https://chainsafe.github.io/canton-x402-sdk/get-started/networks.html): the DevNet and MainNet facilitators

## License

Apache-2.0
