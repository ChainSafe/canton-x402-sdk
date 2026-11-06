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
  ledgerToAtomic,
  WIRE_DECIMALS,
  DEVNET_DSO_PARTY,
  DEVNET_NETWORK,
  DEVNET_SYNCHRONIZER_ID,
  LOCALNET_NETWORK,
  MAINNET_DSO_PARTY,
  MAINNET_NETWORK,
  MAINNET_SYNCHRONIZER_ID,
} from "@chainsafe/x402-core";

// ─── Config ────────────────────────────────────────────────────────────────
const NETWORK = (process.env.NETWORK ?? "localnet").toLowerCase();

/** Network id, DSO party and synchronizer default from the chosen network. */
function networkDefaults(): { networkId: string; dso?: string; synchronizer?: string } {
  if (NETWORK === "devnet")
    return { networkId: DEVNET_NETWORK, dso: DEVNET_DSO_PARTY, synchronizer: DEVNET_SYNCHRONIZER_ID };
  if (NETWORK === "mainnet")
    return { networkId: MAINNET_NETWORK, dso: MAINNET_DSO_PARTY, synchronizer: MAINNET_SYNCHRONIZER_ID };
  // LocalNet allocates both at runtime, so those still have to be passed.
  return { networkId: LOCALNET_NETWORK };
}
const def = networkDefaults();
const NETWORK_ID = process.env.NETWORK_ID?.trim() || def.networkId;
const DSO_PARTY = process.env.DSO_PARTY?.trim() || def.dso;
const SYNCHRONIZER_ID = process.env.SYNCHRONIZER_ID?.trim() || def.synchronizer;
const BUREAU_PARTY = process.env.BUREAU_PARTY;
// Priced in CC, because that is what a human sets. The wire is atomic units,
// so this app converts before quoting.
const PRICE_CC = process.env.PRICE_CC ?? "0.05";
const PORT = Number(process.env.BUREAU_PORT ?? 4001);
const FACILITATOR_URL = process.env.FACILITATOR_URL;
const FACILITATOR_API_KEY = process.env.FACILITATOR_API_KEY;

// NETWORK_ID always has a default now, so it is not checked here.
if (!DSO_PARTY || !SYNCHRONIZER_ID || !BUREAU_PARTY || !FACILITATOR_URL) {
  throw new Error(
    "credit-bureau: set DSO_PARTY, SYNCHRONIZER_ID, BUREAU_PARTY and FACILITATOR_URL " +
      "(see examples/mortgage/.env.example).",
  );
}

const ASSET = amuletAsset(DSO_PARTY);
const PRICE_ATOMIC = ledgerToAtomic(PRICE_CC, WIRE_DECIMALS);
if (PRICE_ATOMIC === null) {
  throw new Error(`credit-bureau: PRICE_CC "${PRICE_CC}" is not a decimal amount (≤10 places).`);
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
      synchronizerId: SYNCHRONIZER_ID,
      payTo: BUREAU_PARTY,
      asset: ASSET,
      amount: PRICE_ATOMIC.toString(),
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

// The x402 `X-PAYMENT` header carries the whole Canton payload (the gzipped
// prepared tx with its disclosed contracts), about 10 KB: much of Node's default
// 16 KB limit, which covers all of a request's headers together. So create the
// server with a generous maxHeaderSize, or a paid request with a few more
// headers is rejected with 431.
createServer({ maxHeaderSize: 4 * 1024 * 1024 }, app).listen(PORT, () => {
  console.log(`[credit-bureau] listening on :${PORT} — network=${NETWORK}, price=${PRICE_CC} CC, payTo=${BUREAU_PARTY}`);
});
