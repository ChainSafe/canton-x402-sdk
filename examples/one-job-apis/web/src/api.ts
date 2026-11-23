import type { Tool } from "@chainsafe/x402-example-one-job-catalog";

import { decodeHeaderJson } from "./headers.js";

const API = "/api";

export interface CallTrace {
  tool: string;
  requestBody: { text: string; other?: string };
  unpaidStatus: number;
  unpaidBody: unknown;
  paymentRequiredHeader: string | null;
  paymentRequiredDecoded: unknown;
  paymentSignature: string | null;
  standInNote?: string;
  paidStatus: number;
  paidBody: unknown;
  paymentResponseHeader: string | null;
  paymentResponseDecoded: unknown;
  serverTrace: unknown;
  handlerSource: string;
}

export async function fetchSource(tool: string): Promise<{ source: string; live: boolean }> {
  const res = await fetch(`${API}/v1/${encodeURIComponent(tool)}/source`);
  const data = (await res.json()) as { source: string; live: boolean };
  return data;
}

export async function runPaidCall(
  tool: Tool,
  body: { text: string; other?: string },
): Promise<CallTrace> {
  const url = `${API}/v1/${encodeURIComponent(tool.tool)}`;
  const unpaid = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const unpaidBody = await unpaid.json();
  const paymentRequiredHeader = unpaid.headers.get("payment-required");
  let paymentRequiredDecoded: unknown = null;
  if (paymentRequiredHeader) {
    try {
      paymentRequiredDecoded = decodeHeaderJson(paymentRequiredHeader);
    } catch {
      paymentRequiredDecoded = { error: "could not decode PAYMENT-REQUIRED" };
    }
  }

  const signRes = await fetch(`${API}/demo/sign`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(unpaidBody),
  });
  const signed = (await signRes.json()) as { paymentSignature: string; note: string };

  const paid = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "payment-signature": signed.paymentSignature,
    },
    body: JSON.stringify(body),
  });
  const paidBody = await paid.json();
  const paymentResponseHeader = paid.headers.get("payment-response");
  let paymentResponseDecoded: unknown = null;
  if (paymentResponseHeader) {
    try {
      paymentResponseDecoded = decodeHeaderJson(paymentResponseHeader);
    } catch {
      paymentResponseDecoded = { error: "could not decode PAYMENT-RESPONSE" };
    }
  }

  const traceHeader = paid.headers.get("x-one-job-trace");
  let serverTrace: unknown = null;
  if (traceHeader) {
    try {
      serverTrace = JSON.parse(atob(traceHeader));
    } catch {
      serverTrace = { error: "bad trace header" };
    }
  }

  const source = await fetchSource(tool.tool);

  return {
    tool: tool.tool,
    requestBody: body,
    unpaidStatus: unpaid.status,
    unpaidBody,
    paymentRequiredHeader,
    paymentRequiredDecoded,
    paymentSignature: signed.paymentSignature,
    standInNote: signed.note,
    paidStatus: paid.status,
    paidBody,
    paymentResponseHeader,
    paymentResponseDecoded,
    serverTrace,
    handlerSource: source.source,
  };
}
