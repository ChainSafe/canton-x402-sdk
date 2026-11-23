// In-process facilitator. Speaks /v2/supported, /v2/verify and /v2/settle so the
// real FacilitatorClient and paymentRequired run. It does not talk to a ledger.
//
// SPDX-License-Identifier: Apache-2.0

import { Router } from "express";

import { DEMO_TRANSACTION, NETWORK, STAND_IN_PAYER, SUPPORTED } from "./deployment.ts";

export function facilitatorRouter(): Router {
  const router = Router();

  router.get("/v2/supported", (_req, res) => {
    res.json(SUPPORTED);
  });

  router.post("/v2/verify", (_req, res) => {
    res.json({ isValid: true, payer: STAND_IN_PAYER });
  });

  router.post("/v2/settle", (_req, res) => {
    res.json({
      success: true,
      network: NETWORK,
      transaction: DEMO_TRANSACTION,
      payer: STAND_IN_PAYER,
    });
  });

  return router;
}
