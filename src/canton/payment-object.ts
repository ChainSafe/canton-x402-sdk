// Canton x402 SDK -- Payment Object Generation

import { randomUUID } from "crypto";
import type { AuthProvider } from "./auth.js";
import type {
  CantonSdkConfig,
  PaymentObjectRequest,
  PaymentObjectResponse,
  PaymentPayload,
  PaymentRequirements,
} from "../types.js";
import { verify } from "./verify.js";

/** SSRF protection: reject internal/private IPs and non-HTTPS URLs. */
function isSafeUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== "https:") return false;
    const host = url.hostname;
    // Reject loopback
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
    // Reject private ranges via simple prefix checks
    if (host.startsWith("10.")) return false;
    if (host.startsWith("192.168.")) return false;
    if (host.startsWith("172.")) {
      const second = parseInt(host.split(".")[1], 10);
      if (second >= 16 && second <= 31) return false;
    }
    // Reject link-local
    if (host.startsWith("169.254.")) return false;
    // Reject 0.0.0.0
    if (host === "0.0.0.0") return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a payment object for a resource server.
 *
 * Calls the Token Standard registry to obtain a TransferFactory contract ID
 * and disclosed contracts needed for settlement.
 */
export async function generatePaymentObject(
  request: PaymentObjectRequest,
  config: CantonSdkConfig,
  auth: AuthProvider,
): Promise<PaymentObjectResponse> {
  // Validate x402 signature if provided
  if (request.x402Signature) {
    const paymentPayload: PaymentPayload = {
      x402Version: 1,
      scheme: "exact-canton",
      network: config.network,
      payload: {
        command: {
          payer: request.payerParty,
          payee: request.merchantParty,
          amount: request.amount,
          currency: "CC",
          resourceId: request.resource,
          nonce: randomUUID(),
        },
        signature: request.x402Signature,
      },
    };
    const requirements: PaymentRequirements = {
      scheme: "exact-canton",
      network: config.network,
      maxAmountRequired: request.amount,
      resource: request.resource,
      description: request.description,
      payTo: request.merchantParty,
      asset: "Amulet",
    };
    const result = await verify(paymentPayload, requirements);
    if (!result.isValid) {
      throw new Error(
        `x402 signature validation failed: ${result.invalidReason}`,
      );
    }
  }

  // Calculate fee (currently 0)
  const amountNum = parseFloat(request.amount);
  if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");
  const fee = "0.00";
  const total = amountNum.toFixed(2);

  // Get holdings if provided
  const holdingCids = request.holdingCids?.length
    ? request.holdingCids
    : [];

  // Get TransferFactory from scan proxy
  const token = await auth.getToken();
  const scanUrl = `${config.scanProxyUrl}/registry/transfer-instruction/v1/transfer-factory`;

  const factoryResponse = await fetch(scanUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      choiceArguments: {
        expectedAdmin: config.dsoParty,
        transfer: {
          sender: request.payerParty,
          receiver: request.merchantParty,
          amount: request.amount,
          instrumentId: { id: "Amulet", admin: config.dsoParty },
          lock: null,
          requestedAt: new Date().toISOString(),
          executeBefore: new Date(Date.now() + 3600000).toISOString(),
          inputHoldingCids: holdingCids,
          meta: {
            values: {
              "splice.lfdecentralizedtrust.org/reason": "x402 payment",
            },
          },
        },
        extraArgs: { context: { values: {} }, meta: { values: {} } },
      },
      excludeDebugFields: true,
    }),
  });

  if (!factoryResponse.ok) {
    const errorText = await factoryResponse.text();
    throw new Error(
      `TransferFactory API failed: ${factoryResponse.status} - ${errorText}`,
    );
  }

  const factoryData = (await factoryResponse.json()) as {
    factoryId: string;
    choiceContext?: { disclosedContracts?: unknown[]; [k: string]: unknown };
  };
  const factoryId = factoryData.factoryId;
  const choiceContext = factoryData.choiceContext ?? {};
  const disclosedContracts =
    (choiceContext as Record<string, unknown>).disclosedContracts ?? [];

  const paymentId = randomUUID();
  const expiresAt =
    request.expiresAt ?? new Date(Date.now() + 3600000).toISOString();

  const paymentObject: PaymentObjectResponse = {
    paymentObject: {
      amount: request.amount,
      merchantParty: request.merchantParty,
      payerParty: request.payerParty,
      expiresAt,
      resource: request.resource,
      description: request.description,
      facilitatorFee: fee,
      totalAmount: total,
      transferFactory: {
        contractId: factoryId,
        disclosedContracts: disclosedContracts as unknown[],
      },
      choiceContext,
    },
    paymentId,
    status: "ready",
    notificationUrl: request.notificationUrl,
  };

  // Fire-and-forget notification (with SSRF protection)
  if (request.notificationUrl) {
    if (!isSafeUrl(request.notificationUrl)) {
      // Silently skip — don't fail the payment object generation
    } else {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      fetch(request.notificationUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(paymentObject),
        signal: controller.signal,
      })
        .catch(() => {})
        .finally(() => clearTimeout(timeout));
    }
  }

  return paymentObject;
}
