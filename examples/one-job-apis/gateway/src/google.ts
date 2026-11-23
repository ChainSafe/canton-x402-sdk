// Google OAuth (OpenID Connect). Create credentials in Google Cloud Console for martin@chainsafe.io.
//
// SPDX-License-Identifier: Apache-2.0

import type { Request } from "express";
import * as oauth from "openid-client";

import { oauthConfig, oauthReady } from "./config.ts";

export type GoogleOidc = oauth.Configuration;

let cached: GoogleOidc | undefined;

export async function googleOidc(): Promise<GoogleOidc> {
  if (cached) return cached;
  const { clientId, clientSecret, redirectUri } = oauthConfig();
  cached = await oauth.discovery(new URL("https://accounts.google.com"), clientId, {
    client_secret: clientSecret,
    redirect_uris: [redirectUri],
    response_types: ["code"],
  });
  return cached;
}

export async function googleAuthUrl(session: Request["session"]): Promise<string> {
  const server = await googleOidc();
  const { redirectUri } = oauthConfig();
  const codeVerifier = oauth.randomPKCECodeVerifier();
  const state = oauth.randomState();
  session.oauthCodeVerifier = codeVerifier;
  session.oauthState = state;
  const url = oauth.buildAuthorizationUrl(server, {
    scope: "openid email profile",
    redirect_uri: redirectUri,
    code_challenge: await oauth.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: "S256",
    state,
  });
  return url.href;
}

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

export async function googleUserFromCallback(req: Request): Promise<GoogleProfile> {
  const server = await googleOidc();
  const { redirectUri } = oauthConfig();
  const callbackUrl = new URL(redirectUri);
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "";
  if (qs) callbackUrl.search = qs;
  if (!req.session.oauthCodeVerifier || !req.session.oauthState) {
    throw new Error("OAuth session expired. Start sign-in again.");
  }
  const tokens = await oauth.authorizationCodeGrant(server, callbackUrl, {
    expectedState: req.session.oauthState,
    pkceCodeVerifier: req.session.oauthCodeVerifier,
  });
  const claims = tokens.claims();
  if (!claims?.sub) throw new Error("Google did not return a subject.");
  return {
    sub: claims.sub,
    email: typeof claims.email === "string" ? claims.email : "",
    name: typeof claims.name === "string" ? claims.name : claims.email?.toString() ?? "User",
    picture: typeof claims.picture === "string" ? claims.picture : undefined,
  };
}

export function assertOauthConfigured(): void {
  if (!oauthReady()) throw new Error("Google OAuth is not configured.");
}