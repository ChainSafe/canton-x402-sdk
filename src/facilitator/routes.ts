// Canton x402 SDK -- Facilitator Route Handlers

import { Router } from "express";
import type { Request, Response } from "express";
import type {
  CantonSdkConfig,
  PaymentPayload,
  PaymentRequirements,
  PaymentObjectRequest,
  FacilitatorOptions,
} from "../types.js";
import { verify } from "../canton/verify.js";
import { generatePaymentObject } from "../canton/payment-object.js";
import { settleLocal, settle } from "../canton/settle.js";
import { CantonJsonClient } from "../canton/json-client.js";
import { createAuthProvider, type AuthProvider } from "../canton/auth.js";
import { NonceStore } from "./nonce-store.js";

/**
 * Create an Express Router with all facilitator endpoints.
 */
export function createFacilitatorRouter(options: FacilitatorOptions): Router {
  const router = Router();
  const config = options.config;
  const networks = options.networks ?? [config.network];
  const auth = createAuthProvider(config.auth);
  const client = new CantonJsonClient(config.ledgerApiUrl, auth);
  const nonceStore = new NonceStore();

  // In-memory payment verification store
  const paymentStore = new Map<
    string,
    { transactionId: string; timestamp: string }
  >();

  router.use((req, _res, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any)._x402Config = config;
    (req as any)._x402Auth = auth;
    (req as any)._x402Client = client;
    next();
  });

  // GET /supported
  router.get("/supported", (_req: Request, res: Response) => {
    res.json({
      kinds: networks.map((network) => ({
        x402Version: 1,
        scheme: "exact-canton",
        network,
        extra: { facilitatorVersion: "0.1.0", provider: "CantonX402SDK" },
      })),
    });
  });

  // POST /verify
  router.post("/verify", async (req: Request, res: Response) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body as {
        paymentPayload: PaymentPayload;
        paymentRequirements: PaymentRequirements;
      };
      if (!paymentPayload || !paymentRequirements) {
        return res.status(400).json({
          error:
            "Missing required fields: paymentPayload and paymentRequirements",
        });
      }

      // Check nonce replay
      const nonce = paymentPayload.payload?.command?.nonce;
      if (nonce && nonceStore.hasNonce(nonce)) {
        return res.json({ isValid: false, invalidReason: "nonce_reused" });
      }

      const result = await verify(paymentPayload, paymentRequirements);
      if (result.isValid && nonce) {
        nonceStore.addNonce(nonce);
      }
      res.json(result);
    } catch (error) {
      res.status(400).json({
        error: "Invalid request",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /settle
  router.post("/settle", async (req: Request, res: Response) => {
    try {
      const { payerParty, payeeParty, amount, resourceId, privateKey, keyFingerprint } =
        req.body;
      if (!payerParty || !payeeParty || !amount) {
        return res.status(400).json({
          error: "Missing required fields: payerParty, payeeParty, amount",
        });
      }

      let result;
      if (config.network === "canton-local") {
        result = await settleLocal(
          { payerParty, payeeParty, amount, resourceId: resourceId ?? "" },
          config,
          client,
          auth,
        );
      } else {
        if (!privateKey || !keyFingerprint) {
          return res.status(400).json({
            error: "DevNet/MainNet settlement requires privateKey and keyFingerprint",
          });
        }
        result = await settle(
          { payerParty, payeeParty, amount, resourceId: resourceId ?? "", privateKey, keyFingerprint },
          config,
          client,
          auth,
        );
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: "Settlement failed",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /payment-object
  router.post("/payment-object", async (req: Request, res: Response) => {
    try {
      const body: PaymentObjectRequest = req.body;
      if (!body.amount || !body.merchantParty || !body.payerParty || !body.resource) {
        return res.status(400).json({
          error: "Missing required fields: amount, merchantParty, payerParty, resource",
        });
      }
      const result = await generatePaymentObject(body, config, auth);
      res.json(result);
    } catch (error) {
      res.status(400).json({
        error: "Payment object generation failed",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /verify-payment -- verify a transaction on-chain
  router.post("/verify-payment", async (req: Request, res: Response) => {
    try {
      const { party, payee, amount, resource, transactionId } = req.body;
      if (!party || !payee || !amount || !transactionId) {
        return res.status(400).json({
          error: "Missing required fields: party, payee, amount, transactionId",
        });
      }

      const requiredAmount = parseFloat(amount);
      if (isNaN(requiredAmount) || requiredAmount <= 0) {
        return res.status(400).json({ error: "Invalid amount" });
      }

      const txData = (await client.getTransactionById(transactionId, [
        party,
        payee,
      ])) as { transaction?: { events?: unknown[] } };
      const transaction = txData.transaction;
      if (!transaction) {
        return res.status(404).json({ error: "Transaction not found on ledger", transactionId });
      }

      const events = (transaction.events ?? []) as Record<string, unknown>[];
      let verified = false;
      for (const event of events) {
        const exercisedEvent = (event.ExercisedEvent ??
          event.exercisedEvent) as Record<string, unknown> | undefined;
        if (!exercisedEvent) continue;
        const templateId = String(exercisedEvent.templateId ?? "");
        const choice = String(exercisedEvent.choice ?? "");
        if (
          templateId.includes("TransferPreapproval") &&
          (choice === "Send" || choice === "TransferPreapproval_Send")
        ) {
          const args = exercisedEvent.choiceArgument as Record<string, unknown>;
          const eventAmount = parseFloat(String(args?.amount ?? ""));
          const witnessParties = (exercisedEvent.witnessParties ?? []) as string[];
          if (
            !isNaN(eventAmount) &&
            Math.abs(eventAmount - requiredAmount) < 0.0001 &&
            witnessParties.includes(payee)
          ) {
            verified = true;
            break;
          }
        }
      }

      if (!verified) {
        return res.status(400).json({
          error: "Transaction does not match payment details",
          transactionId,
        });
      }

      const key = `${party}::${payee}::${requiredAmount}::${resource ?? ""}`;
      paymentStore.set(key, {
        transactionId,
        timestamp: new Date().toISOString(),
      });

      res.json({ success: true, verified: true, transactionId });
    } catch (error) {
      res.status(500).json({
        error: "Failed to verify transaction on ledger",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // GET /check-payment-status
  router.get("/check-payment-status", (req: Request, res: Response) => {
    const { party, payee, amount, resource } = req.query as Record<
      string,
      string | undefined
    >;
    if (!party || !payee || !amount) {
      return res.status(400).json({
        error: "Missing required query parameters: party, payee, amount",
      });
    }
    const requiredAmount = parseFloat(amount);
    if (isNaN(requiredAmount) || requiredAmount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const key = `${party}::${payee}::${requiredAmount}::${resource ?? ""}`;
    const stored = paymentStore.get(key);
    if (stored) {
      return res.json({
        hasPaid: true,
        transactionId: stored.transactionId,
        timestamp: stored.timestamp,
      });
    }
    res.json({ hasPaid: false });
  });

  // GET /transaction/:id -- fetch full transaction details from Canton ledger
  router.get("/transaction/:id", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const partiesParam = req.query.parties as string | undefined;
      if (!partiesParam) {
        return res.status(400).json({ error: "Missing required query parameter: parties (comma-separated)" });
      }
      const parties = partiesParam.split(",").map((p) => p.trim()).filter(Boolean);
      const txData = await client.getTransactionById(id, parties);
      const transaction = (txData as { transaction?: unknown }).transaction;
      if (!transaction) {
        return res.status(404).json({ error: "Transaction not found", updateId: id });
      }
      res.json(transaction);
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch transaction",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // GET /health
  router.get("/health", async (_req: Request, res: Response) => {
    try {
      const cantonHealthy = await client.healthCheck();
      res.json({
        status: cantonHealthy ? "healthy" : "degraded",
        facilitator: "ok",
        canton: cantonHealthy ? "connected" : "disconnected",
        version: "0.1.0",
      });
    } catch (error) {
      res.status(503).json({
        status: "unhealthy",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
