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
import { invokeMerchant } from "./pay.ts";
import {
  canSpend,
  findUserById,
  passkeysForUser,
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
app.use(express.json({ limit: "64kb" }));
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
  res.json({ ok: true, oauth: oauthReady() });
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
  });
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
  const toolId = String(req.params.tool ?? "");
  const challenge = req.session.webauthnChallenge;
  const assertion = req.body?.assertion as AuthenticationResponseJSON | undefined;
  if (!challenge || !assertion) {
    res.status(400).json({ error: "Place your finger first (payment approval missing)." });
    return;
  }

  const text = String(req.body?.text ?? "");
  const other = req.body?.other !== undefined ? String(req.body.other) : undefined;
  if (!text.trim()) {
    res.status(400).json({ error: "text is required." });
    return;
  }

  try {
    await verifyAuthentication(req.session.userId!, assertion, challenge);
    delete req.session.webauthnChallenge;
  } catch (err) {
    res.status(401).json({ error: err instanceof Error ? err.message : "Fingerprint check failed." });
    return;
  }

  const cents = findTool(toolId)?.cents ?? 1;
  const budget = canSpend(req.session.userId!, cents, DAILY_CAP_CENTS);
  if (!budget.ok) {
    res.status(429).json({ error: budget.reason });
    return;
  }

  try {
    const body = other !== undefined ? { text, other } : { text };
    const paid = await invokeMerchant(toolId, body);
    recordSpend(req.session.userId!, cents);
    res.json(paid);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Payment failed." });
  }
});

createServer(app).listen(PORT, "127.0.0.1", () => {
  console.log(`[one-job-gateway] http://127.0.0.1:${PORT} (public ${PUBLIC_ORIGIN})`);
});