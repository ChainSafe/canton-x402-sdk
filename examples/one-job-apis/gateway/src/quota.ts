// Prepaid call packs — one x402 sale, many job runs without per-call payment.
//
// SPDX-License-Identifier: Apache-2.0

export interface QuotaPack {
  id: string;
  title: string;
  calls: number;
  /** Merchant tool that carries the single bulk sale. */
  merchantTool: string;
  priceCents: number;
  pitch: string;
}

export const QUOTA_PACKS: readonly QuotaPack[] = [
  {
    id: "25",
    title: "25-call pack",
    calls: 25,
    merchantTool: "bulk.25",
    priceCents: 10,
    pitch: "For a short pilot — one invoice, then twenty-five runs.",
  },
  {
    id: "100",
    title: "100-call pack",
    calls: 100,
    merchantTool: "bulk.100",
    priceCents: 35,
    pitch: "The usual bulk buy. Pay once, stop thinking about cents per click.",
  },
  {
    id: "500",
    title: "500-call pack",
    calls: 500,
    merchantTool: "bulk.500",
    priceCents: 150,
    pitch: "Agent-shaped volume. One settlement, then five hundred calls.",
  },
];

export function packById(id: string): QuotaPack | undefined {
  return QUOTA_PACKS.find((p) => p.id === id);
}