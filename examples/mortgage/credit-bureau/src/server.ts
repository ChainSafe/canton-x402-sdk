// Credit bureau — the x402 MERCHANT in the mortgage demo.
//
// Sells one synthetic credit report per pull. `GET /v1/credit-score?subject=…` is
// gated by @chainsafe/x402-express `paymentRequired()`: without a valid `X-PAYMENT`
// it answers 402 with the price (0.05 CC); with one, it verifies + settles via the
// Canton facilitator and returns the report. The score is deterministic from the
// subject id, so the demo is reproducible with no external data source.
//
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";
// Load the demo's shared env (examples/mortgage/.env) regardless of cwd. Harmless
// if absent (docker-compose passes env directly).
loadEnv({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

import express from "express";
import { FacilitatorClient } from "@chainsafe/x402-client";
import { paymentRequired } from "@chainsafe/x402-express";
import {
  amuletAsset,
  DEVNET_DSO_PARTY,
  DEVNET_NETWORK,
  MAINNET_DSO_PARTY,
  MAINNET_NETWORK,
} from "@chainsafe/x402-core";

// ─── Config ────────────────────────────────────────────────────────────────
const NETWORK = (process.env.NETWORK ?? "localnet").toLowerCase();

/** Network id + DSO party default from the chosen network; LocalNet must supply them. */
function networkDefaults(): { networkId?: string; dso?: string } {
  if (NETWORK === "devnet") return { networkId: DEVNET_NETWORK, dso: DEVNET_DSO_PARTY };
  if (NETWORK === "mainnet") return { networkId: MAINNET_NETWORK, dso: MAINNET_DSO_PARTY };
  return {}; // localnet: per-instance, pass NETWORK_ID + DSO_PARTY
}
const def = networkDefaults();
const NETWORK_ID = process.env.NETWORK_ID ?? def.networkId;
const DSO_PARTY = process.env.DSO_PARTY ?? def.dso;
const BUREAU_PARTY = process.env.BUREAU_PARTY;
const PRICE_CC = process.env.PRICE_CC ?? "0.05";
const PORT = Number(process.env.BUREAU_PORT ?? 4001);
const FACILITATOR_URL = process.env.FACILITATOR_URL;
const FACILITATOR_API_KEY = process.env.FACILITATOR_API_KEY;

if (!NETWORK_ID || !DSO_PARTY || !BUREAU_PARTY || !FACILITATOR_URL) {
  throw new Error(
    "credit-bureau: set NETWORK_ID, DSO_PARTY, BUREAU_PARTY and FACILITATOR_URL " +
      "(see examples/mortgage/.env.example).",
  );
}

const facilitator = new FacilitatorClient(
  FACILITATOR_URL,
  FACILITATOR_API_KEY ? { apiKey: FACILITATOR_API_KEY } : {},
);

// ─── Synthetic, deterministic credit report ──────────────────────────────────
function creditReport(subject: string) {
  const digest = createHash("sha256").update(subject).digest();
  const score = 300 + (digest.readUInt32BE(0) % 551); // 300–850
  const band =
    score >= 800 ? "Exceptional"
    : score >= 740 ? "Very Good"
    : score >= 670 ? "Good"
    : score >= 580 ? "Fair"
    : "Poor";
  const factors =
    score >= 740
      ? ["low credit utilization", "no recent delinquencies", "long credit history"]
      : score >= 670
        ? ["moderate utilization", "no delinquencies in 24mo"]
        : ["high utilization", "limited credit history"];
  return {
    subject,
    score,
    band,
    factors,
    reportId: `rpt_${digest.toString("hex").slice(0, 16)}`,
    asOf: new Date().toISOString().slice(0, 10),
  };
}

// ─── Server ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "credit-bureau", network: NETWORK });
});

// Gate the credit-score endpoint behind a 0.05 CC payment, settled on Canton.
app.use(
  "/v1/credit-score",
  paymentRequired({
    facilitator,
    settle: true,
    requirements: {
      network: NETWORK_ID,
      payTo: BUREAU_PARTY,
      asset: amuletAsset(DSO_PARTY),
      amount: PRICE_CC,
      description: "Credit-score pull",
    },
  }),
);

app.get("/v1/credit-score", (req, res) => {
  const subject = String(req.query.subject ?? "").trim();
  if (!subject) {
    res.status(400).json({ error: "subject query param is required" });
    return;
  }
  res.json({ ...creditReport(subject), payer: req.x402?.payer, cost: `${PRICE_CC} CC` });
});

// The x402 `X-PAYMENT` header carries the whole Canton payload (prepared-tx blob +
// disclosed contracts), which far exceeds Node's default 16 KB header limit — so
// create the server with a generous maxHeaderSize. Merchants gating Canton x402
// routes must do this or the request is rejected with 431.
createServer({ maxHeaderSize: 4 * 1024 * 1024 }, app).listen(PORT, () => {
  console.log(`[credit-bureau] listening on :${PORT} — network=${NETWORK}, price=${PRICE_CC} CC, payTo=${BUREAU_PARTY}`);
});
