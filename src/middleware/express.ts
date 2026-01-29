// Canton x402 SDK -- Express Middleware

import type { Request, Response, NextFunction } from "express";
import type { PaymentGateOptions, PaymentRequirements, PaymentPayload } from "../types.js";

/**
 * Express middleware that gates a route behind an x402 Canton payment.
 *
 * If the request has no `X-PAYMENT` header, returns 402 with requirements.
 * If present, decodes the payment and calls the facilitator `/verify` endpoint.
 * On valid payment, attaches `req.x402` and calls `next()`.
 */
export function paymentRequired(options: PaymentGateOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const paymentHeader = req.headers["x-payment"] as string | undefined;
    const price = options.getPrice
      ? options.getPrice(req)
      : options.amount;

    const requirements: PaymentRequirements = {
      scheme: "exact-canton",
      network: options.network ?? "canton-local",
      maxAmountRequired: price,
      resource: req.originalUrl,
      description: options.description,
      payTo: options.payTo,
      asset: options.asset ?? "CC",
    };

    if (!paymentHeader) {
      // No payment -- return 402
      const encoded = Buffer.from(JSON.stringify([requirements])).toString(
        "base64",
      );
      res.setHeader("X-PAYMENT-REQUIRED", encoded);
      return res.status(402).json({
        x402Version: 1,
        accepts: [requirements],
        error: "Payment Required",
      });
    }

    // Decode payment
    let paymentPayload: PaymentPayload;
    try {
      const decoded = Buffer.from(paymentHeader, "base64").toString("utf-8");
      paymentPayload = JSON.parse(decoded) as PaymentPayload;
    } catch {
      return res.status(402).json({
        x402Version: 1,
        accepts: [requirements],
        error: "Invalid X-PAYMENT header encoding",
      });
    }

    // Verify via facilitator
    try {
      const verifyResponse = await fetch(
        `${options.facilitatorUrl}/verify`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paymentPayload,
            paymentRequirements: requirements,
          }),
        },
      );

      if (!verifyResponse.ok) {
        return res.status(402).json({
          x402Version: 1,
          accepts: [requirements],
          error: "Payment verification failed",
        });
      }

      const result = (await verifyResponse.json()) as {
        isValid: boolean;
        invalidReason?: string;
        payer?: string;
      };

      if (!result.isValid) {
        return res.status(402).json({
          x402Version: 1,
          accepts: [requirements],
          error: `Payment invalid: ${result.invalidReason}`,
        });
      }

      // Attach payment info to request
      (req as unknown as Record<string, unknown>).x402 = {
        payer: result.payer,
        payload: paymentPayload,
      };
      next();
    } catch (error) {
      return res.status(402).json({
        x402Version: 1,
        accepts: [requirements],
        error: `Verification error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };
}
