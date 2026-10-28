// Getting started, the merchant side: the "Putting it together" block.
//
// Transcluded into docs/getting-started.md (only the `snippet` region is
// shown), and compiled by `pnpm typecheck` but never run: no facilitator, no
// key, no ledger. A breaking change to an SDK signature this calls fails the
// typecheck here, so edit the code in this file, not in the page (#69).

// #region snippet
import http from "node:http";
import express from "express";
import { FacilitatorClient } from "@chainsafe/x402-client";
import { paymentRequired } from "@chainsafe/x402-express";
import { amuletAsset } from "@chainsafe/x402-core";

// The .env the dashboard's integration panel gives you (API keys page).
const NETWORK = process.env.NETWORK_ID!; // from GET /v2/supported (step 4)
const DSO_PARTY = process.env.AMULET_ADMIN!; // from GET /v2/supported (step 4)
const PAY_TO = process.env.MERCHANT_PARTY!; // your payout party (step 1)
const API_KEY = process.env.FACILITATOR_API_KEY!; // your API key (step 2)

const facilitator = new FacilitatorClient(process.env.FACILITATOR_URL!, { apiKey: API_KEY });

const app = express();

// Gate one route behind a 0.05 CC payment, settled on Canton.
app.use(
  "/paid",
  paymentRequired({
    facilitator,
    settle: true,
    requirements: {
      network: NETWORK,
      payTo: PAY_TO,
      asset: amuletAsset(DSO_PARTY),
      amount: "0.05",
      description: "Access to /paid",
    },
  }),
);

app.get("/paid", (req, res) => {
  // Paid + verified — req.x402 carries the payer and the settle result.
  res.json({ ok: true, payer: req.x402!.payer });
});

// Raise maxHeaderSize (step 6) or the paid retry 431s before the handler runs.
http
  .createServer({ maxHeaderSize: 4 * 1024 * 1024 }, app)
  .listen(3000, () => console.log("listening on :3000"));
// #endregion snippet
