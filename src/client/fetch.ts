// Canton x402 SDK -- Client Fetch Wrapper

import type {
  X402FetchOptions,
  PaymentRequirements,
  PaymentPayload,
  CantonSdkConfig,
} from "../types.js";
import { createAuthProvider } from "../canton/auth.js";
import { CantonJsonClient } from "../canton/json-client.js";
import { settleLocal, settle } from "../canton/settle.js";
import { randomUUID } from "crypto";

/**
 * Create a fetch-compatible function that automatically handles 402 responses.
 *
 * 1. Makes the initial request.
 * 2. If not 402, returns the response as-is.
 * 3. If 402, parses payment requirements, settles via Canton, and retries
 *    the request with an `X-PAYMENT` header containing the payment proof.
 */
export function createX402Fetch(options: X402FetchOptions) {
  const auth = createAuthProvider(options.config.auth);
  const client = new CantonJsonClient(options.config.ledgerApiUrl, auth);

  return async (
    url: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    // 1. Initial request
    const response = await fetch(url, init);
    if (response.status !== 402) return response;

    // 2. Parse 402 body
    const body = (await response.json()) as {
      x402Version?: number;
      accepts?: PaymentRequirements[];
    };

    const requirements = body.accepts?.find(
      (r) => r.scheme === "exact-canton",
    );
    if (!requirements) {
      throw new Error(
        "Server returned 402 but no exact-canton payment scheme found",
      );
    }

    console.log(
      `[x402] Payment required: ${requirements.maxAmountRequired} CC to ${requirements.payTo}`,
    );

    // 3. Settle
    const settleOpts = {
      payerParty: options.payerParty,
      payeeParty: requirements.payTo,
      amount: requirements.maxAmountRequired,
      resourceId: requirements.resource,
    };

    let settleResult;
    if (options.config.network === "canton-local") {
      settleResult = await settleLocal(settleOpts, options.config, client, auth);
    } else {
      if (!options.privateKey || !options.keyFingerprint) {
        throw new Error(
          "DevNet/MainNet settlement requires privateKey and keyFingerprint in X402FetchOptions",
        );
      }
      settleResult = await settle(
        { ...settleOpts, privateKey: options.privateKey, keyFingerprint: options.keyFingerprint },
        options.config,
        client,
        auth,
      );
    }

    if (!settleResult.success) {
      throw new Error(`Settlement failed: ${settleResult.error}`);
    }

    console.log(
      `[x402] Payment settled: tx=${settleResult.transactionId}`,
    );

    // 4. Build payment payload
    const paymentPayload: PaymentPayload = {
      x402Version: 1,
      scheme: "exact-canton",
      network: options.config.network,
      payload: {
        command: {
          payer: options.payerParty,
          payee: requirements.payTo,
          amount: requirements.maxAmountRequired,
          currency: requirements.asset ?? "CC",
          resourceId: requirements.resource,
          nonce: randomUUID(),
        },
      },
    };

    const paymentHeader = Buffer.from(
      JSON.stringify(paymentPayload),
    ).toString("base64");

    // 5. Retry with payment
    console.log(`[x402] Retrying request with payment proof...`);
    const retryInit: RequestInit = { ...init };
    retryInit.headers = {
      ...(init?.headers as Record<string, string>),
      "X-PAYMENT": paymentHeader,
    };

    return fetch(url, retryInit);
  };
}
