// Canton x402 SDK -- Auth Providers

import * as jose from "jose";
import type { AuthMode } from "../types.js";

// ─── AuthProvider Interface ────────────────────────────────────────────────

export interface AuthProvider {
  getToken(): Promise<string>;
  getUserId(): string;
}

// ─── Shared Secret Auth (cn-quickstart / localnet) ─────────────────────────

export class SharedSecretAuthProvider implements AuthProvider {
  private secret: Uint8Array;
  private userId: string;
  private audience: string;
  private cachedToken: string | null = null;
  private expiresAt = 0;

  constructor(secret: string, userId: string, audience?: string) {
    this.secret = new TextEncoder().encode(secret);
    this.userId = userId;
    this.audience = audience ?? "https://canton.network.global";
  }

  async getToken(): Promise<string> {
    if (this.cachedToken && this.expiresAt > Date.now() + 60_000) {
      return this.cachedToken;
    }
    const now = Math.floor(Date.now() / 1000);
    const token = await new jose.SignJWT({
      sub: this.userId,
      aud: this.audience,
      scope: "daml_ledger_api",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(this.secret);

    this.cachedToken = token;
    this.expiresAt = Date.now() + 3600_000;
    return token;
  }

  getUserId(): string {
    return this.userId;
  }
}

// ─── OAuth2 Auth (DevNet / MainNet) ────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export class OAuth2AuthProvider implements AuthProvider {
  private tokenUrl: string;
  private clientId: string;
  private clientSecret: string;
  private audience?: string;
  private scope?: string;
  private cachedToken: string | null = null;
  private expiresAt = 0;
  private cachedUserId: string | null = null;

  constructor(opts: {
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    audience?: string;
    scope?: string;
  }) {
    this.tokenUrl = opts.tokenUrl;
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.audience = opts.audience;
    this.scope = opts.scope;
  }

  async getToken(): Promise<string> {
    if (this.cachedToken && this.expiresAt > Date.now() + 300_000) {
      return this.cachedToken;
    }

    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    if (this.audience) params.append("audience", this.audience);
    if (this.scope) params.append("scope", this.scope);

    const response = await fetch(this.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `OAuth2 token request failed: ${response.status} ${error}`,
      );
    }

    const data = (await response.json()) as TokenResponse;
    this.cachedToken = data.access_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;
    this.cachedUserId = decodeJwtSub(data.access_token);
    return data.access_token;
  }

  getUserId(): string {
    if (this.cachedUserId) return this.cachedUserId;
    throw new Error("Must call getToken() before getUserId()");
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────

export function createAuthProvider(auth: AuthMode): AuthProvider {
  switch (auth.type) {
    case "shared-secret":
      return new SharedSecretAuthProvider(
        auth.secret,
        auth.userId,
        auth.audience,
      );
    case "oauth2":
      return new OAuth2AuthProvider({
        tokenUrl: auth.tokenUrl,
        clientId: auth.clientId,
        clientSecret: auth.clientSecret,
        audience: auth.audience,
        scope: auth.scope,
      });
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function decodeJwtSub(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf-8");
    const claims = JSON.parse(decoded);
    return claims.sub ?? null;
  } catch {
    return null;
  }
}
