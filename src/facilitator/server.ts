// Canton x402 SDK -- Standalone Facilitator Server

import express from "express";
import type { FacilitatorOptions } from "../types.js";
import { createFacilitatorRouter } from "./routes.js";

/**
 * Start a standalone facilitator HTTP server.
 */
export function startFacilitator(
  options: FacilitatorOptions & { port?: number },
): void {
  const port = options.port ?? 3100;
  const app = express();
  app.use(express.json());
  app.use("/", createFacilitatorRouter(options));

  app.listen(port, () => {
    console.log(`Canton x402 Facilitator running on http://localhost:${port}`);
    console.log(`  Network: ${options.config.network}`);
    console.log(`  Ledger:  ${options.config.ledgerApiUrl}`);
  });
}
