// Mortgage-application backend.
//
// Receives a home-mortgage application from the UI, underwrites it by pulling the
// applicant's credit score from the bureau — an x402-paid, server-to-server call
// (0.05 CC settled on Canton) via the auto-paying fetch — then applies a simple
// lending policy and returns the decision plus the on-chain payment receipt.
//
// The UI → backend leg is a normal web request; only the backend → bureau leg is paid.
//
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";
loadEnv({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

import express from "express";

import { buildX402Fetch } from "./payer.js";

// ─── Config ────────────────────────────────────────────────────────────────
const PORT = Number(process.env.MORTGAGE_BACKEND_PORT ?? 4002);
const BUREAU_URL = (process.env.BUREAU_URL ?? "http://localhost:4001").replace(/\/$/, "");
const PRICE_CC = process.env.PRICE_CC ?? "0.05";
const APPROVE_MIN_SCORE = Number(process.env.APPROVE_MIN_SCORE ?? 700);
const MAX_LOAN = Number(process.env.MAX_LOAN ?? 2_000_000);
const MAX_LTV = Number(process.env.MAX_LTV ?? 0.9);

/** Mask an SSN for display/logging: 123-45-6789 → ***-**-6789. */
function maskSsn(ssn: string): string {
  const digits = ssn.replace(/\D/g, "");
  return digits.length >= 4 ? `***-**-${digits.slice(-4)}` : "***";
}

interface CreditReport {
  subject: string;
  score: number;
  band: string;
  factors: string[];
  reportId: string;
  asOf: string;
}

// ─── Server ──────────────────────────────────────────────────────────────────
async function main() {
  // Build the auto-paying fetch once (connects to the participant Ledger API).
  const pay = await buildX402Fetch();

  const app = express();
  app.use(express.json());

  // Permissive CORS so the separately-served UI (docker) can call this directly.
  app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", process.env.UI_ORIGIN ?? "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "content-type");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get("/health", (_req, res) => res.json({ ok: true, service: "mortgage-backend" }));

  app.post("/apply", async (req, res) => {
    const { name, ssn, income, propertyPrice, loanAmount, downPayment, termYears } = req.body ?? {};
    // The credit pull is keyed on the applicant's SSN — the bureau's lookup id.
    const subject = String(ssn ?? "").trim();
    const price = Number(propertyPrice);
    const loan = Number(loanAmount);
    if (!subject || !Number.isFinite(price) || price <= 0 || !Number.isFinite(loan) || loan <= 0) {
      res.status(400).json({ error: "ssn, propertyPrice and loanAmount are required" });
      return;
    }

    // Pay-per-pull credit check (x402 → Canton). createX402Fetch handles the 402.
    console.log(`[mortgage-backend] applicant "${name}" (ssn ${maskSsn(subject)}) — pulling credit score (paying ${PRICE_CC} CC)…`);
    let creditRes: Response;
    try {
      creditRes = await pay(`${BUREAU_URL}/v1/credit-score?subject=${encodeURIComponent(subject)}`);
    } catch (err) {
      console.error("[mortgage-backend] credit pull failed:", err);
      res.status(502).json({ error: "credit bureau unreachable", details: String(err) });
      return;
    }
    if (!creditRes.ok) {
      const body = await creditRes.text();
      res.status(502).json({ error: `credit bureau returned ${creditRes.status}`, details: body.slice(0, 500) });
      return;
    }

    const report = (await creditRes.json()) as CreditReport;
    const updateId = creditRes.headers.get("X-PAYMENT-RESPONSE"); // Canton settlement id
    console.log(`[mortgage-backend] score=${report.score} (${report.band}) — settled ${updateId ?? "(no receipt)"}`);

    // Lending policy.
    const ltv = loan / price;
    const reasons: string[] = [];
    if (report.score < APPROVE_MIN_SCORE) reasons.push(`credit score ${report.score} below ${APPROVE_MIN_SCORE}`);
    if (loan > MAX_LOAN) reasons.push(`loan ${loan} exceeds cap ${MAX_LOAN}`);
    if (ltv > MAX_LTV) reasons.push(`LTV ${(ltv * 100).toFixed(1)}% exceeds ${(MAX_LTV * 100).toFixed(0)}%`);
    const approved = reasons.length === 0;

    res.json({
      decision: approved ? "APPROVED" : "DECLINED",
      reasons,
      applicant: { name, income, propertyPrice: price, loanAmount: loan, downPayment, termYears },
      ltv: Number(ltv.toFixed(4)),
      credit: { subject: maskSsn(subject), score: report.score, band: report.band, factors: report.factors, reportId: report.reportId, asOf: report.asOf },
      payment: { amountCC: PRICE_CC, updateId, settled: Boolean(updateId) },
    });
  });

  app.listen(PORT, () => {
    console.log(`[mortgage-backend] listening on :${PORT} — bureau=${BUREAU_URL}, policy: score≥${APPROVE_MIN_SCORE}, loan≤${MAX_LOAN}, LTV≤${MAX_LTV}`);
  });
}

main().catch((err) => {
  console.error("[mortgage-backend] failed to start:", err);
  process.exit(1);
});
