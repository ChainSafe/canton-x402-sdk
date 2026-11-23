// The merchant. Live tools are gated by paymentRequired. The others answer
// before any quote, so they never charge.
//
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";

import { FacilitatorClient } from "@chainsafe/x402-client";
import { ledgerToAtomic, WIRE_DECIMALS, type CantonPaymentRequirements } from "@chainsafe/x402-core";
import { paymentRequired } from "@chainsafe/x402-express";
import { findTool, NEEDS_OTHER, TOOLS, type Tool } from "@chainsafe/x402-example-one-job-catalog";
import express, { type Express, type Request } from "express";

import { MERCHANT, NETWORK } from "./deployment.ts";
import { facilitatorRouter } from "./facilitator.ts";
import { readInput, type JobInput } from "./input.ts";
import { signStandIn, STAND_IN_NOTE } from "./stand-in.ts";
import { HANDLERS } from "./tools/registry.ts";

export const TRACE_HEADER = "X-One-Job-Trace";

for (const entry of TOOLS) {
  if (entry.live && HANDLERS[entry.tool] === undefined) {
    throw new Error(`one-job: ${entry.tool} is marked live and has no handler`);
  }
}

interface Pending {
  tool: Tool;
  input: JobInput;
}

export function createApp(port: number): Express {
  const facilitator = new FacilitatorClient(`http://127.0.0.1:${port}/facilitator`);
  const pending = new WeakMap<Request, Pending>();
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use("/facilitator", facilitatorRouter());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "one-job-api" });
  });

  app.get("/v1/:tool/source", (req, res) => {
    const tool = findTool(toolId(req));
    if (!tool) {
      res.status(404).json({ error: "Unknown tool." });
      return;
    }
    const handler = HANDLERS[tool.tool];
    res.json({
      tool: tool.tool,
      live: tool.live,
      source: handler ? readFileSync(handler.file, "utf8") : notBuilt(tool),
      see: tool.live ? undefined : "hash.sha256",
    });
  });

  app.post("/demo/sign", (req, res) => {
    const accepts = readAccepts(req.body);
    if (!accepts) {
      res.status(400).json({ error: "Send the 402 body, with accepts." });
      return;
    }
    res.json({ paymentSignature: signStandIn(accepts), note: STAND_IN_NOTE });
  });

  app.post(
    "/v1/:tool",
    (req, res, next) => {
      const tool = findTool(toolId(req));
      if (!tool) {
        res.status(404).json({ error: "Unknown tool." });
        return;
      }
      if (!tool.live) {
        res.status(501).json({ error: "This job is not in this build.", see: "hash.sha256" });
        return;
      }
      const input = readInput(req.body, NEEDS_OTHER.has(tool.tool));
      if ("error" in input) {
        res.status(400).json({ error: input.error });
        return;
      }
      pending.set(req, { tool, input });
      next();
    },
    paymentRequired({
      facilitator,
      settle: true,
      requirements: {
        network: NETWORK,
        payTo: MERCHANT,
        description: (req) => pending.get(req)?.tool.result ?? "one job",
        accepts: [
          {
            asset: "Amulet",
            amount: (req) => atomicCents(pending.get(req)?.tool.cents ?? 1),
          },
        ],
      },
    }),
    (req, res) => {
      const job = pending.get(req);
      const handler = job ? HANDLERS[job.tool.tool] : undefined;
      if (!job || !handler) {
        res.status(500).json({ error: "The call lost its input." });
        return;
      }
      let result: unknown;
      try {
        result = handler.run(job.input);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "The job failed." });
        return;
      }
      res.setHeader(
        TRACE_HEADER,
        Buffer.from(
          JSON.stringify({
            standIn: true,
            note: STAND_IN_NOTE,
            verify: req.x402?.verify ?? null,
            settle: req.x402?.settle ?? null,
          }),
        ).toString("base64"),
      );
      res.json({ result });
    },
  );

  return app;
}

export function listen(app: Express, port: number): Promise<{ close: () => Promise<void> }> {
  const server: Server = createServer({ maxHeaderSize: 1024 * 1024 }, app);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

function atomicCents(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const frac = String(cents % 100).padStart(2, "0");
  const atomic = ledgerToAtomic(`${whole}.${frac}`, WIRE_DECIMALS);
  if (atomic === null) throw new Error(`one-job: ${cents} cents is not a Canton Coin amount`);
  return atomic.toString();
}

function toolId(req: Request): string {
  const value = req.params["tool"];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function readAccepts(body: unknown): CantonPaymentRequirements[] | undefined {
  if (body === null || typeof body !== "object" || !("accepts" in body)) return undefined;
  const accepts = (body as { accepts?: unknown }).accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) return undefined;
  return accepts as CantonPaymentRequirements[];
}

function notBuilt(tool: Tool): string {
  return [
    `// ${tool.tool} is not in this build.`,
    "// Open hash.sha256 and pay once to watch the same exchange.",
    "// paymentRequired would sit in front of this function.",
    "",
    "export function run(_input: { text: string }): unknown {",
    '  throw new Error("not in this build");',
    "}",
    "",
  ].join("\n");
}
