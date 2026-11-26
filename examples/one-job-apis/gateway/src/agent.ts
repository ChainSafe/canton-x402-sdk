// A scripted delegate. The plan for each task is fixed so the demo runs the same
// way every time; the calls, the 402s and the payments behind it are real.
//
// SPDX-License-Identifier: Apache-2.0

import { findTool } from "@chainsafe/x402-example-one-job-catalog";

import { invokeMerchant, invokeMerchantPrepaid } from "./pay.ts";
import { consumePrepaidCall, prepaidCallsFor } from "./store.ts";

type Results = Record<string, unknown>;

interface PlanStep {
  tool: string;
  /** Why the agent picked this job, in one line. */
  why: string;
  input: (r: Results) => { text: string; other?: string };
}

interface Task {
  id: string;
  title: string;
  /** What the person typed. */
  ask: string;
  steps: PlanStep[];
  answer: (r: Results, skipped: string[]) => string;
}

const CONTACTS = [
  "name,email,phone,company",
  "Ada Lovelace,ada@example.com,+44 20 7946 0958,Analytical Engines",
  "Grace Hopper,grace@example.org,+1 415 555 0100,Compilers Inc",
  "Alan Turing,alan@example.net,+44 161 496 0000,Bletchley Labs",
].join("\n");

const DEPLOY_TOKEN =
  "eyJhbGciOiJub25lIn0.eyJzdWIiOiJkZXBsb3ktYm90IiwiZXhwIjoxODAwMDAwMDAwLCJzY29wZSI6ImRlcGxveTpwcm9kIn0.";

function get<T = unknown>(r: Results, tool: string, key: string): T | undefined {
  const v = r[tool];
  if (v && typeof v === "object" && key in v) return (v as Record<string, T>)[key];
  return undefined;
}

export const TASKS: Task[] = [
  {
    id: "domain-check",
    title: "Vet a partner's domain",
    ask: "Before I email chainsafe.io, check the site is up, the certificate is fine and their mail is set up. Short answer.",
    steps: [
      { tool: "url.status", why: "Is the site answering?", input: () => ({ text: "https://chainsafe.io" }) },
      { tool: "cert.expiry", why: "When does the certificate run out?", input: () => ({ text: "chainsafe.io" }) },
      { tool: "dns.lookup", why: "Who handles their mail?", input: () => ({ text: "chainsafe.io", other: "MX" }) },
      { tool: "email.mx", why: "Would an address there receive mail?", input: () => ({ text: "info@chainsafe.io" }) },
      {
        tool: "text.summary",
        why: "Boil the findings down for you",
        input: (r) => ({ text: findings(r).join(" ") || "No checks came back.", other: "40" }),
      },
    ],
    answer: (r, skipped) => {
      const lines = findings(r);
      const summary = get<string>(r, "text.summary", "summary");
      const head = summary ?? (lines.length ? lines.join(" ") : "None of the checks came back.");
      return skipped.length ? `${head} Not checked: ${skipped.join(", ")}.` : head;
    },
  },
  {
    id: "contacts",
    title: "Clean a contact export",
    ask: "Turn this contact export into JSON for the CRM, with emails and phone numbers masked, and give me a fingerprint of the clean file.",
    steps: [
      { tool: "text.pii", why: "Mask emails and phone numbers first", input: () => ({ text: CONTACTS }) },
      {
        tool: "csv.json",
        why: "Turn the masked CSV into rows",
        input: (r) => ({ text: get<string>(r, "text.pii", "text") ?? CONTACTS }),
      },
      {
        tool: "hash.sha256",
        why: "Fingerprint the clean file so you can prove what was imported",
        input: (r) => ({ text: JSON.stringify(get(r, "csv.json", "rows") ?? []) }),
      },
    ],
    answer: (r, skipped) => {
      const rows = get<unknown[]>(r, "csv.json", "rows");
      const hex = get<string>(r, "hash.sha256", "hex");
      const parts = [
        rows ? `${rows.length} contacts are ready for the CRM, with emails and phone numbers masked.` : "The export could not be converted.",
        hex ? `Fingerprint of the clean file: ${hex.slice(0, 16)}…` : "",
      ];
      if (skipped.length) parts.push(`Not done: ${skipped.join(", ")}.`);
      return parts.filter(Boolean).join(" ");
    },
  },
  {
    id: "deploy-token",
    title: "Read a deploy token",
    ask: "What can this deploy token do, and when does the job that uses it run? It runs on 0 9 * * 1-5.",
    steps: [
      { tool: "jwt.read", why: "Decode what the token claims", input: () => ({ text: DEPLOY_TOKEN }) },
      { tool: "cron.english", why: "Put the schedule into words", input: () => ({ text: "0 9 * * 1-5" }) },
    ],
    answer: (r, skipped) => {
      const payload = get<Record<string, unknown>>(r, "jwt.read", "payload");
      const sentence = get<string>(r, "cron.english", "sentence");
      const parts: string[] = [];
      if (payload) {
        const exp = typeof payload.exp === "number" ? new Date(payload.exp * 1000).toISOString().slice(0, 10) : "no date";
        parts.push(`The token belongs to ${String(payload.sub ?? "an unnamed subject")}, may ${String(payload.scope ?? "do nothing stated")}, and expires on ${exp}. Its signature was not checked.`);
      }
      if (sentence) parts.push(`The job runs ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`);
      if (skipped.length) parts.push(`Not done: ${skipped.join(", ")}.`);
      return parts.join(" ") || "Nothing came back.";
    },
  },
];

function findings(r: Results): string[] {
  const out: string[] = [];
  const status = get<number>(r, "url.status", "status");
  if (status !== undefined) out.push(`The site answers with HTTP ${status}.`);
  const until = get<string>(r, "cert.expiry", "validTo");
  if (until) {
    const ms = Date.parse(until);
    const days = Number.isNaN(ms) ? undefined : Math.floor((ms - Date.now()) / 86_400_000);
    out.push(days !== undefined ? `The certificate has ${days} days left.` : `The certificate is valid until ${until}.`);
  }
  const records = get<Array<{ exchange?: string }>>(r, "dns.lookup", "records");
  if (records?.length) out.push(`Mail goes to ${records.map((x) => x.exchange).filter(Boolean).slice(0, 2).join(" and ")}.`);
  const valid = get<boolean>(r, "email.mx", "validSyntax");
  const mx = get<unknown[]>(r, "email.mx", "mx");
  if (valid !== undefined) out.push(mx?.length ? "An address there can receive mail." : "No mail server answered for that address.");
  return out;
}

export function publicTasks() {
  return TASKS.map((t) => ({
    id: t.id,
    title: t.title,
    ask: t.ask,
    steps: t.steps.map((s) => ({ tool: s.tool, why: s.why, cents: findTool(s.tool)?.cents ?? 1 })),
  }));
}

export type AgentEvent =
  | { type: "plan"; task: string; budgetCents: number; steps: Array<{ tool: string; why: string; cents: number }> }
  | { type: "step"; index: number; state: "asking" | "paid" | "failed" | "skipped"; tool: string; cents: number; spent: number; note?: string; result?: unknown; transaction?: string }
  | { type: "done"; answer: string; spent: number; budgetCents: number; calls: number };

/**
 * Run a task inside a budget. `pay` is called once per settled job so the
 * caller can record the spend and ring the till.
 */
export async function runTask(
  taskId: string,
  budgetCents: number,
  emit: (e: AgentEvent) => void,
  onPaid: (tool: string, cents: number, transaction: string) => void,
  canAfford: (cents: number) => boolean,
  userId: string,
): Promise<void> {
  const task = TASKS.find((t) => t.id === taskId);
  if (!task) throw new Error("Unknown task.");

  const plan = task.steps.map((s) => ({ tool: s.tool, why: s.why, cents: findTool(s.tool)?.cents ?? 1 }));
  emit({ type: "plan", task: task.id, budgetCents, steps: plan });

  const results: Results = {};
  const skipped: string[] = [];
  let spent = 0;
  let calls = 0;

  for (const [index, step] of task.steps.entries()) {
    const cents = plan[index]!.cents;
    const useQuota = prepaidCallsFor(userId) > 0;
    if (!useQuota) {
      if (spent + cents > budgetCents) {
        skipped.push(step.tool);
        emit({ type: "step", index, state: "skipped", tool: step.tool, cents, spent, note: `${cents}¢ would go over the ${budgetCents}¢ budget` });
        continue;
      }
      if (!canAfford(cents)) {
        skipped.push(step.tool);
        emit({ type: "step", index, state: "skipped", tool: step.tool, cents, spent, note: "Your daily cap is used up" });
        continue;
      }
    }
    emit({ type: "step", index, state: "asking", tool: step.tool, cents: useQuota ? 0 : cents, spent });
    await pause(450);
    try {
      const input = step.input(results);
      const paid = useQuota
        ? await invokeMerchantPrepaid(step.tool, input)
        : await invokeMerchant(step.tool, input);
      if (useQuota && !consumePrepaidCall(userId)) {
        throw new Error("Prepaid quota ran out.");
      }
      results[step.tool] = paid.result;
      spent += useQuota ? 0 : cents;
      calls += 1;
      onPaid(step.tool, useQuota ? 0 : cents, paid.receipt.transaction);
      emit({
        type: "step",
        index,
        state: "paid",
        tool: step.tool,
        cents: useQuota ? 0 : cents,
        spent,
        result: paid.result,
        transaction: paid.receipt.transaction,
        note: useQuota ? "Spent prepaid quota (no per-call 402)." : undefined,
      });
    } catch (err) {
      skipped.push(step.tool);
      emit({ type: "step", index, state: "failed", tool: step.tool, cents, spent, note: shortError(err) });
    }
    await pause(250);
  }

  emit({ type: "done", answer: task.answer(results, skipped), spent, budgetCents, calls });
}

function shortError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {
    /* not json */
  }
  return raw.slice(0, 120);
}

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
