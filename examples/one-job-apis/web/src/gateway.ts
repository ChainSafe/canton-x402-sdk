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
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status} from ${path}`);
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
  prepaidCalls?: number;
}

export interface QuotaPack {
  id: string;
  title: string;
  calls: number;
  priceCents: number;
  pitch: string;
}

export async function fetchMe(): Promise<Me> {
  return gw<Me>("/auth/me");
}

export interface GatewayHealth {
  ok: boolean;
  oauth: boolean;
  devLogin?: boolean;
}

export async function fetchGatewayHealth(): Promise<GatewayHealth | null> {
  try {
    return await gw<GatewayHealth>("/health");
  } catch {
    return null;
  }
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
    billing?: "prepaid" | "x402";
  };
  trace: Record<string, unknown>;
  prepaidCalls?: number;
}

/** Uses prepaid quota when available; otherwise passkey + x402 per call. */
export async function executeJob(
  tool: string,
  body: { text: string; other?: string },
  prepaidCalls: number,
  payPerCall = false,
): Promise<PayResult> {
  if (prepaidCalls > 0 && !payPerCall) {
    return gw<PayResult>(`/v1/${encodeURIComponent(tool)}/pay`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  const options = await gw<PublicKeyCredentialRequestOptionsJSON>("/webauthn/payment/options", {
    method: "POST",
    body: "{}",
  });
  const assertion = await startAuthentication({ optionsJSON: options });
  return gw<PayResult>(`/v1/${encodeURIComponent(tool)}/pay`, {
    method: "POST",
    body: JSON.stringify({ ...body, assertion, payPerCall: true }),
  });
}

export async function fetchQuotaPacks(): Promise<{ packs: QuotaPack[] }> {
  return gw<{ packs: QuotaPack[] }>("/quota/packs");
}

export async function purchaseQuotaPack(
  packId: string,
): Promise<{ granted: number; prepaidCalls: number; pack: string }> {
  const options = await gw<PublicKeyCredentialRequestOptionsJSON>("/webauthn/payment/options", {
    method: "POST",
    body: "{}",
  });
  const assertion = await startAuthentication({ optionsJSON: options });
  return gw("/quota/purchase", {
    method: "POST",
    body: JSON.stringify({ pack: packId, assertion }),
  });
}
// ---- delegate agent ----

export interface AgentTask {
  id: string;
  title: string;
  ask: string;
  steps: Array<{ tool: string; why: string; cents: number }>;
}

export type AgentEvent =
  | { type: "plan"; task: string; budgetCents: number; steps: AgentTask["steps"] }
  | {
      type: "step";
      index: number;
      state: "asking" | "paid" | "failed" | "skipped";
      tool: string;
      cents: number;
      spent: number;
      note?: string;
      result?: unknown;
      transaction?: string;
    }
  | { type: "done"; answer: string; spent: number; budgetCents: number; calls: number }
  | { type: "error"; error: string };

export async function fetchAgentTasks(): Promise<{ tasks: AgentTask[]; maxBudgetCents: number }> {
  return gw("/agent/tasks");
}

/** One passkey approval for the whole budget, then a stream of what the agent did. */
export async function runAgent(
  task: string,
  budgetCents: number,
  onEvent: (e: AgentEvent) => void,
): Promise<void> {
  const options = await gw<PublicKeyCredentialRequestOptionsJSON>("/webauthn/payment/options", {
    method: "POST",
    body: "{}",
  });
  const assertion = await startAuthentication({ optionsJSON: options });
  const res = await fetch(`${GW}/agent/run`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task, budgetCents, assertion }),
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as AgentEvent);
    }
  }
}

// ---- the owner's till ----

export interface Sale {
  id: number;
  at: string;
  tool: string;
  cents: number;
  caller: "person" | "agent";
  payer: string;
  transaction: string;
}

export interface TillState {
  sales: Sale[];
  totals: { calls: number; cents: number; payers: number; byAgents: number };
}

export function subscribeTill(onState: (s: TillState) => void, onSale: (s: Sale) => void): () => void {
  const source = new EventSource(`${GW}/till/stream`);
  source.addEventListener("snapshot", (e) => onState(JSON.parse((e as MessageEvent).data) as TillState));
  source.addEventListener("sale", (e) => onSale(JSON.parse((e as MessageEvent).data) as Sale));
  return () => source.close();
}
