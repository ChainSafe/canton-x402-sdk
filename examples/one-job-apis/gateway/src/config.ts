// SPDX-License-Identifier: Apache-2.0

function req(name: string, value: string | undefined): string {
  const v = value?.trim();
  if (!v) throw new Error(`gateway: set ${name} (see examples/one-job-apis/gateway/.env.example)`);
  return v;
}

export const PORT = Number(process.env.GATEWAY_PORT ?? 8790);
export const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN ?? "http://localhost:5180").replace(/\/$/, "");
export const MERCHANT_URL = (process.env.MERCHANT_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");

export const RP_ID = process.env.WEBAUTHN_RP_ID?.trim() || new URL(PUBLIC_ORIGIN).hostname;
export const RP_NAME = process.env.WEBAUTHN_RP_NAME?.trim() || "ChainSafe one-job APIs";
export const RP_ORIGIN = process.env.WEBAUTHN_ORIGIN?.trim() || PUBLIC_ORIGIN;

export const DAILY_CAP_CENTS = Number(process.env.DAILY_SPEND_CAP_CENTS ?? 500);

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID?.trim();
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET?.trim();
export const SESSION_SECRET = process.env.SESSION_SECRET?.trim() ?? "dev-only-change-me";

export function oauthReady(): boolean {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

export function oauthConfig() {
  return {
    clientId: req("GOOGLE_CLIENT_ID", GOOGLE_CLIENT_ID),
    clientSecret: req("GOOGLE_CLIENT_SECRET", GOOGLE_CLIENT_SECRET),
    redirectUri: `${PUBLIC_ORIGIN}/gateway/auth/google/callback`,
  };
}