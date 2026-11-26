// The merchant's till: every settled call, whoever made it. In memory only;
// a restart empties it, which is what a demo wants.
//
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";

import type { Request, Response } from "express";

export type Caller = "person" | "agent";

export interface Sale {
  id: number;
  at: string;
  tool: string;
  cents: number;
  caller: Caller;
  /** Who paid, as the owner would see it: a wallet-ish label, not an account. */
  payer: string;
  transaction: string;
}

const MAX = 40;
const sales: Sale[] = [];
const bus = new EventEmitter();
bus.setMaxListeners(100);
let nextId = 1;

export function recordSale(sale: Omit<Sale, "id" | "at">): Sale {
  const full: Sale = { ...sale, id: nextId++, at: new Date().toISOString() };
  sales.unshift(full);
  if (sales.length > MAX) sales.length = MAX;
  bus.emit("sale", full);
  return full;
}

export function tillSnapshot() {
  const payers = new Set(sales.map((s) => s.payer));
  return {
    sales,
    totals: {
      calls: sales.length,
      cents: sales.reduce((n, s) => n + s.cents, 0),
      payers: payers.size,
      byAgents: sales.filter((s) => s.caller === "agent").length,
    },
  };
}

/** Server-sent events: one `sale` event per settled call. */
export function tillStream(req: Request, res: Response): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(`event: snapshot\ndata: ${JSON.stringify(tillSnapshot())}\n\n`);
  const onSale = (sale: Sale) => res.write(`event: sale\ndata: ${JSON.stringify(sale)}\n\n`);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  bus.on("sale", onSale);
  req.on("close", () => {
    clearInterval(ping);
    bus.off("sale", onSale);
  });
}
