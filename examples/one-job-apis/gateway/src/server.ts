// SPDX-License-Identifier: Apache-2.0

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import cookieParser from "cookie-parser";
import { config as loadEnv } from "dotenv";
import express from "express";
import session from "express-session";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

import { findTool } from "@chainsafe/x402-example-one-job-catalog";

import { DAILY_CAP_CENTS, PORT, PUBLIC_ORIGIN, SESSION_SECRET, oauthReady } from "./config.ts";
import { assertOauthConfigured, googleAuthUrl, googleUserFromCallback } from "./google.ts";
import { publicTasks, runTask, type AgentEvent } from "./agent.ts";
import { packById, QUOTA_PACKS } from "./quota.ts";
import { invokeMerchant, invokeMerchantPrepaid } from "./pay.ts";
import { recordSale, tillSnapshot, tillStream } from "./till.ts";
import {
  addPrepaidCalls,
  canSpend,
  consumePrepaidCall,
  findUserById,
  passkeysForUser,
  prepaidCallsFor,
  recordSpend,
  resetSpendIfNewDay,
  upsertGoogleUser,
} from "./store.ts";
import {
  authenticationOptions,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from "./webauthn.ts";

loadEnv({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const app = express();
app.set("trust proxy", 1);
app.use(cookieParser());
app.use(express.json({ limit: "4mb" }));
app.use(
  session({
    name: "onejob.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/",
    },
  }),
);

function requireUser(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!req.session.userId) {
    res.status(401).json({ error: "Sign in first." });
    return;
  }
  next();
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    oauth: oauthReady(),
    devLogin: process.env.ALLOW_DEV_LOGIN === "1",
  });
});

app.get("/auth/me", (req, res) => {
  if (!req.session.userId) {
    res.json({ signedIn: false });
    return;
  }
  const user = findUserById(req.session.userId);
  if (!user) {
    res.json({ signedIn: false });
    return;
  }
  const fresh = resetSpendIfNewDay(user);
  res.json({
    signedIn: true,
    email: fresh.email,
    name: fresh.name,
    picture: fresh.picture,
    hasPasskey: passkeysForUser(fresh.id).length > 0,
    spentCentsToday: fresh.spentCentsToday,
    dailyCapCents: DAILY_CAP_CENTS,
    prepaidCalls: prepaidCallsFor(fresh.id),
  });
});

app.get("/quota/packs", (_req, res) => {
  res.json({
    packs: QUOTA_PACKS.map((p) => ({
      id: p.id,
      title: p.title,
      calls: p.calls,
      priceCents: p.priceCents,
      pitch: p.pitch,
    })),
  });
});

app.post("/quota/purchase", requireUser, async (req, res) => {
  const pack = packById(String(req.body?.pack ?? ""));
  if (!pack) {
    res.status(400).json({ error: "Unknown pack." });
    return;
  }
  const challenge = req.session.webauthnChallenge;
  const assertion = req.body?.assertion as AuthenticationResponseJSON | undefined;
  if (!challenge || !assertion) {
    res.status(400).json({ error: "Approve the bulk sale with your passkey first." });
    return;
  }
  try {
    await verifyAuthentication(req.session.userId!, assertion, challenge);
    delete req.session.webauthnChallenge;
  } catch (err) {
    res.status(401).json({ error: err instanceof Error ? err.message : "Passkey check failed." });
    return;
  }

  const budget = canSpend(req.session.userId!, pack.priceCents, DAILY_CAP_CENTS);
  if (!budget.ok) {
    res.status(429).json({ error: budget.reason });
    return;
  }

  try {
    const paid = await invokeMerchant(pack.merchantTool, { text: pack.id });
    recordSpend(req.session.userId!, pack.priceCents);
    const remaining = addPrepaidCalls(req.session.userId!, pack.calls);
    recordSale({
      tool: pack.merchantTool,
      cents: pack.priceCents,
      caller: "person",
      payer: payerLabel(req.session.userId!, "person"),
      transaction: paid.receipt.transaction,
    });
    res.json({ pack: pack.id, granted: pack.calls, prepaidCalls: remaining, receipt: paid.receipt });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Bulk purchase failed." });
  }
});

app.get("/auth/google", async (req, res) => {
  try {
    assertOauthConfigured();
    const url = await googleAuthUrl(req.session);
    res.redirect(url);
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : "Google OAuth unavailable." });
  }
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    assertOauthConfigured();
    const profile = await googleUserFromCallback(req);
    const user = upsertGoogleUser({
      googleSub: profile.sub,
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
    });
    req.session.userId = user.id;
    delete req.session.oauthCodeVerifier;
    delete req.session.oauthState;
    res.redirect(`${PUBLIC_ORIGIN}/?signed_in=1`);
  } catch (err) {
    res.status(400).send(err instanceof Error ? err.message : "Sign-in failed.");
  }
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

if (process.env.ALLOW_DEV_LOGIN === "1") {
  app.post("/auth/dev-login", (req, res) => {
    const email = String(req.body?.email ?? "demo@chainsafe.io").trim();
    const user = upsertGoogleUser({
      googleSub: `dev:${email}`,
      email,
      name: email.split("@")[0] ?? "Demo",
    });
    req.session.userId = user.id;
    res.json({ ok: true });
  });
}

app.post("/webauthn/register/options", requireUser, async (req, res) => {
  const user = findUserById(req.session.userId!);
  if (!user) {
    res.status(401).json({ error: "Sign in again." });
    return;
  }
  const options = await registrationOptions(user.id, user.email);
  req.session.webauthnChallenge = options.challenge;
  res.json(options);
});

app.post("/webauthn/register/verify", requireUser, async (req, res) => {
  const challenge = req.session.webauthnChallenge;
  if (!challenge) {
    res.status(400).json({ error: "Registration expired. Try again." });
    return;
  }
  try {
    await verifyRegistration(req.session.userId!, req.body as RegistrationResponseJSON, challenge);
    delete req.session.webauthnChallenge;
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Registration failed." });
  }
});

app.post("/webauthn/payment/options", requireUser, async (req, res) => {
  try {
    const options = await authenticationOptions(req.session.userId!);
    req.session.webauthnChallenge = options.challenge;
    res.json(options);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Passkey required." });
  }
});

app.post("/v1/:tool/pay", requireUser, async (req, res) => {
  const userId = req.session.userId!;
  const toolId = String(req.params.tool ?? "");
  const text = String(req.body?.text ?? "");
  const other = req.body?.other !== undefined ? String(req.body.other) : undefined;
  if (!text.trim()) {
    res.status(400).json({ error: "text is required." });
    return;
  }
  const body = other !== undefined ? { text, other } : { text };
  const payPerCall = req.body?.payPerCall === true;
  const quotaLeft = prepaidCallsFor(userId);

  if (quotaLeft > 0 && !payPerCall) {
    try {
      const paid = await invokeMerchantPrepaid(toolId, body);
      if (!consumePrepaidCall(userId)) {
        res.status(409).json({ error: "Quota ran out before this call could finish." });
        return;
      }
      recordSale({
        tool: toolId,
        cents: 0,
        caller: "person",
        payer: payerLabel(userId, "person"),
        transaction: paid.receipt.transaction,
      });
      res.json({ ...paid, prepaidCalls: prepaidCallsFor(userId) });
      return;
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "Call failed." });
      return;
    }
  }

  const challenge = req.session.webauthnChallenge;
  const assertion = req.body?.assertion as AuthenticationResponseJSON | undefined;
  if (!challenge || !assertion) {
    res.status(400).json({
      error:
        quotaLeft > 0
          ? "No prepaid calls left for this path — passkey required, or buy another pack."
          : "Place your finger first (payment approval missing).",
    });
    return;
  }

  try {
    await verifyAuthentication(userId, assertion, challenge);
    delete req.session.webauthnChallenge;
  } catch (err) {
    res.status(401).json({ error: err instanceof Error ? err.message : "Fingerprint check failed." });
    return;
  }

  const cents = findTool(toolId)?.cents ?? 1;
  const budget = canSpend(userId, cents, DAILY_CAP_CENTS);
  if (!budget.ok) {
    res.status(429).json({ error: budget.reason });
    return;
  }

  try {
    const paid = await invokeMerchant(toolId, body);
    recordSpend(userId, cents);
    recordSale({
      tool: toolId,
      cents,
      caller: "person",
      payer: payerLabel(userId, "person"),
      transaction: paid.receipt.transaction,
    });
    res.json({ ...paid, prepaidCalls: prepaidCallsFor(userId) });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Payment failed." });
  }
});

// ---- the owner's till ----

app.get("/till", (_req, res) => {
  res.json(tillSnapshot());
});

app.get("/till/stream", (req, res) => {
  tillStream(req, res);
});

// ---- the delegate agent ----

const MAX_AGENT_BUDGET = 50;

app.get("/agent/tasks", (_req, res) => {
  res.json({ tasks: publicTasks(), maxBudgetCents: MAX_AGENT_BUDGET });
});

/**
 * One passkey approval covers a budget, not a call. The agent then pays each
 * job inside that budget with no further prompt. Streams NDJSON events.
 */
app.post("/agent/run", requireUser, async (req, res) => {
  const userId = req.session.userId!;
  const challenge = req.session.webauthnChallenge;
  const assertion = req.body?.assertion as AuthenticationResponseJSON | undefined;
  const taskId = String(req.body?.task ?? "");
  const budgetCents = Math.round(Number(req.body?.budgetCents ?? 0));

  if (!challenge || !assertion) {
    res.status(400).json({ error: "Approve the budget with your passkey first." });
    return;
  }
  if (!Number.isFinite(budgetCents) || budgetCents < 1 || budgetCents > MAX_AGENT_BUDGET) {
    res.status(400).json({ error: `Pick a budget between 1¢ and ${MAX_AGENT_BUDGET}¢.` });
    return;
  }
  try {
    await verifyAuthentication(userId, assertion, challenge);
    delete req.session.webauthnChallenge;
  } catch (err) {
    res.status(401).json({ error: err instanceof Error ? err.message : "Passkey check failed." });
    return;
  }

  res.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
  });
  const emit = (e: AgentEvent) => res.write(`${JSON.stringify(e)}\n`);
  try {
    await runTask(
      taskId,
      budgetCents,
      emit,
      (tool, cents, transaction) => {
        if (cents > 0) recordSpend(userId, cents);
        recordSale({ tool, cents, caller: "agent", payer: payerLabel(userId, "agent"), transaction });
      },
      (cents) => (cents === 0 ? true : canSpend(userId, cents, DAILY_CAP_CENTS).ok),
      userId,
    );
  } catch (err) {
    res.write(`${JSON.stringify({ type: "error", error: err instanceof Error ? err.message : "The agent stopped." })}\n`);
  }
  res.end();
});

function payerLabel(userId: string, caller: "person" | "agent"): string {
  const user = findUserById(userId);
  const who = (user?.email ?? "someone").split("@")[0];
  return caller === "agent" ? `agent of ${who}` : who;
}

createServer(app).listen(PORT, "127.0.0.1", () => {
  console.log(`[one-job-gateway] http://127.0.0.1:${PORT} (public ${PUBLIC_ORIGIN})`);
});