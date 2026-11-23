import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

const GW = "/gateway";

async function gw<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GW}${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export interface Me {
  signedIn: boolean;
  email?: string;
  name?: string;
  picture?: string;
  hasPasskey?: boolean;
  spentCentsToday?: number;
  dailyCapCents?: number;
}

export async function fetchMe(): Promise<Me> {
  return gw<Me>("/auth/me");
}

export function signInWithGoogle(): void {
  window.location.href = `${GW}/auth/google`;
}

export async function devLogin(email: string): Promise<void> {
  await gw("/auth/dev-login", { method: "POST", body: JSON.stringify({ email }) });
}

export async function logout(): Promise<void> {
  await gw("/auth/logout", { method: "POST", body: "{}" });
}

export async function registerPasskey(): Promise<void> {
  const options = await gw<PublicKeyCredentialCreationOptionsJSON>("/webauthn/register/options", {
    method: "POST",
    body: "{}",
  });
  const attestation = await startRegistration({ optionsJSON: options });
  await gw("/webauthn/register/verify", { method: "POST", body: JSON.stringify(attestation) });
}

export interface PayResult {
  result: unknown;
  receipt: {
    tool: string;
    cents: number;
    payer: string;
    transaction: string;
    network: string;
    demo: boolean;
  };
  trace: Record<string, unknown>;
}

export async function payWithFingerprint(
  tool: string,
  body: { text: string; other?: string },
): Promise<{ assertion: AuthenticationResponseJSON; paid: PayResult }> {
  const options = await gw<PublicKeyCredentialRequestOptionsJSON>("/webauthn/payment/options", {
    method: "POST",
    body: "{}",
  });
  const assertion = await startAuthentication({ optionsJSON: options });
  const paid = await gw<PayResult>(`/v1/${encodeURIComponent(tool)}/pay`, {
    method: "POST",
    body: JSON.stringify({ ...body, assertion }),
  });
  return { assertion, paid };
}