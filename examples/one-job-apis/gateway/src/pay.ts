// Paid call through the merchant. Stand-in signature today; swap for CantonX402Payer when funded.
//
// SPDX-License-Identifier: Apache-2.0

import { findTool } from "@chainsafe/x402-example-one-job-catalog";

import { GATEWAY_INTERNAL_SECRET, MERCHANT_URL } from "./config.ts";
const TRACE_HEADER = "x-one-job-trace";

function decodeHeaderJson(header: string | null): unknown {
  if (!header) return null;
  const binary = atob(header);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

/** Run a job using prepaid quota — merchant skips 402 when the gateway vouches. */
export async function invokeMerchantPrepaid(
  toolId: string,
  body: { text: string; other?: string },
): Promise<{
  result: unknown;
  receipt: {
    tool: string;
    cents: number;
    payer: string;
    transaction: string;
    network: string;
    demo: boolean;
    billing: "prepaid";
  };
  trace: Record<string, unknown>;
}> {
  const tool = findTool(toolId);
  if (!tool || !tool.live) throw new Error("This tool is not live.");

  const url = `${MERCHANT_URL}/v1/${encodeURIComponent(toolId)}/exec`;
  const paid = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-one-job-gateway": GATEWAY_INTERNAL_SECRET,
    },
    body: JSON.stringify(body),
  });
  const paidBody = await paid.json();
  if (paid.status !== 200) throw new Error(JSON.stringify(paidBody));

  const traceHeader = paid.headers.get(TRACE_HEADER.toLowerCase());
  let serverTrace: unknown = null;
  if (traceHeader) {
    try {
      serverTrace = JSON.parse(atob(traceHeader));
    } catch {
      serverTrace = null;
    }
  }

  return {
    result: (paidBody as { result?: unknown }).result ?? paidBody,
    receipt: {
      tool: toolId,
      cents: 0,
      payer: "prepaid-pack",
      transaction: `quota-${Date.now()}`,
      network: "bulk-quota",
      demo: true,
      billing: "prepaid",
    },
    trace: {
      requestBody: body,
      prepaid: true,
      serverTrace,
    },
  };
}

export async function invokeMerchant(
  toolId: string,
  body: { text: string; other?: string },
): Promise<{
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
}> {
  const tool = findTool(toolId);
  if (!tool || !tool.live) throw new Error("This tool is not live.");

  const url = `${MERCHANT_URL}/v1/${encodeURIComponent(toolId)}`;
  const unpaid = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const unpaidBody = await unpaid.json();
  if (unpaid.status !== 402) {
    throw new Error(`Expected 402, got ${unpaid.status}: ${JSON.stringify(unpaidBody)}`);
  }

  const signRes = await fetch(`${MERCHANT_URL}/demo/sign`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(unpaidBody),
  });
  const signed = (await signRes.json()) as { paymentSignature: string };
  if (!signRes.ok) throw new Error("Could not sign payment.");

  const paid = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "payment-signature": signed.paymentSignature,
    },
    body: JSON.stringify(body),
  });
  const paidBody = await paid.json();
  if (paid.status !== 200) throw new Error(JSON.stringify(paidBody));

  const paymentResponse = decodeHeaderJson(paid.headers.get("payment-response"));
  const traceHeader = paid.headers.get(TRACE_HEADER.toLowerCase());
  let serverTrace: unknown = null;
  if (traceHeader) {
    try {
      serverTrace = JSON.parse(atob(traceHeader));
    } catch {
      serverTrace = null;
    }
  }
  const settle =
    paymentResponse && typeof paymentResponse === "object" && paymentResponse !== null
      ? paymentResponse
      : serverTrace && typeof serverTrace === "object" && "settle" in (serverTrace as object)
        ? (serverTrace as { settle: unknown }).settle
        : null;

  const receipt = {
    tool: toolId,
    cents: tool.cents,
    payer:
      settle && typeof settle === "object" && settle !== null && "payer" in settle
        ? String((settle as { payer?: string }).payer ?? "demo-payer")
        : "demo-payer",
    transaction:
      settle && typeof settle === "object" && settle !== null && "transaction" in settle
        ? String((settle as { transaction?: string }).transaction ?? "")
        : "",
    network:
      settle && typeof settle === "object" && settle !== null && "network" in settle
        ? String((settle as { network?: string }).network ?? "")
        : "",
    demo: true,
  };

  return {
    result: (paidBody as { result?: unknown }).result ?? paidBody,
    receipt,
    trace: {
      requestBody: body,
      paymentRequired: decodeHeaderJson(unpaid.headers.get("payment-required")),
      paymentResponse: paymentResponse,
      serverTrace,
    },
  };
}