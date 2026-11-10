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

// The .env the dashboard's integration panel gives you (API keys page).
// The network and the instrument are NOT in here: the middleware reads them
// from the facilitator's own GET /v2/supported, so there is no copy of them to
// keep true when a deployment changes.
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
      // Only what is the merchant's own business: who is paid, for what...
      payTo: PAY_TO,
      description: "Access to /paid",
      // ...and the ways to pay for it. One here; add an entry per instrument.
      accepts: [{ amount: "500000000" }], // atomic units: 1 CC = 1e10, so 0.05 CC
    },
  }),
);

app.get("/paid", (req, res) => {
  // Paid + verified — req.x402 carries the payer and the settle result.
  res.json({ ok: true, payer: req.x402!.payer });
});

// Raise maxHeaderSize (step 6): PAYMENT-SIGNATURE is about 10 KB, much of Node's 16 KB
// default for all headers, so a paid retry can 431 before the handler runs.
http
  .createServer({ maxHeaderSize: 4 * 1024 * 1024 }, app)
  .listen(3000, () => console.log("listening on :3000"));
// #endregion snippet
