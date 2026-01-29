// Canton x402 SDK -- Settlement

import { randomUUID } from "crypto";
import type { AuthProvider } from "./auth.js";
import type {
  CantonSdkConfig,
  SettleOptions,
  SettleInteractiveOptions,
  SettleResponse,
} from "../types.js";
import { CantonJsonClient } from "./json-client.js";

/**
 * Settle a payment on localnet via direct JSON API v2 command submission.
 *
 * cn-quickstart's participant node trusts the shared-secret JWT,
 * so no external Ed25519 signing is needed.
 */
export async function settleLocal(
  options: SettleOptions,
  config: CantonSdkConfig,
  client: CantonJsonClient,
  auth: AuthProvider,
): Promise<SettleResponse> {
  const { payerParty, payeeParty, amount, resourceId } = options;

  // 1. Get payer holdings
  const holdingCids = await client.getPayerHoldings(
    payerParty,
    config.spliceHoldingPackageId,
  );
  if (holdingCids.length === 0) {
    return {
      success: false,
      error: `No Amulet holdings found for payer ${payerParty}. Please fund the account first.`,
    };
  }

  // 2. Get TransferFactory from scan proxy
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
          sender: payerParty,
          receiver: payeeParty,
          amount,
          instrumentId: { id: "Amulet", admin: config.dsoParty },
          lock: null,
          requestedAt: new Date().toISOString(),
          executeBefore: new Date(Date.now() + 3600000).toISOString(),
          inputHoldingCids: holdingCids,
          meta: {
            values: {
              "splice.lfdecentralizedtrust.org/reason": `x402 payment for ${resourceId}`,
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
    return {
      success: false,
      error: `TransferFactory API failed: ${factoryResponse.status} - ${errorText}`,
    };
  }

  const factoryData = (await factoryResponse.json()) as {
    factoryId: string;
    choiceContext?: { disclosedContracts?: unknown[]; [k: string]: unknown };
  };

  const factoryId = factoryData.factoryId;
  const choiceContext = factoryData.choiceContext ?? {};
  const disclosedContracts =
    (choiceContext as Record<string, unknown>).disclosedContracts ?? [];

  // 3. Build and submit exercise command via direct submission
  const userId = auth.getUserId();
  const commandId = `x402-settle-${Date.now()}`;

  const result = await client.submitAndWait({
    userId,
    commandId,
    actAs: [payerParty],
    readAs: [payerParty, config.dsoParty, payeeParty],
    commands: [
      {
        ExerciseCommand: {
          templateId:
            "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory",
          contractId: factoryId,
          choice: "TransferFactory_Transfer",
          choiceArgument: {
            expectedAdmin: config.dsoParty,
            transfer: {
              sender: payerParty,
              receiver: payeeParty,
              amount,
              instrumentId: { id: "Amulet", admin: config.dsoParty },
              lock: null,
              requestedAt: new Date().toISOString(),
              executeBefore: new Date(Date.now() + 3600000).toISOString(),
              inputHoldingCids: holdingCids,
              meta: {
                values: {
                  "splice.lfdecentralizedtrust.org/reason": `x402 payment for ${resourceId}`,
                },
              },
            },
            extraArgs: {
              context:
                (choiceContext as Record<string, unknown>).choiceContextData ??
                choiceContext ??
                { values: {} },
              meta: { values: {} },
            },
          },
        },
      },
    ],
    disclosedContracts,
  });

  return { success: true, transactionId: result.updateId };
}

/**
 * Settle a payment on devnet/mainnet via interactive submission with Ed25519 signing.
 */
export async function settle(
  options: SettleInteractiveOptions,
  config: CantonSdkConfig,
  client: CantonJsonClient,
  auth: AuthProvider,
): Promise<SettleResponse> {
  // Dynamically import Ed25519 (optional dependency)
  let edSign: (hash: Uint8Array, privateKey: Uint8Array) => Promise<Uint8Array>;
  try {
    const ed25519 = await import("@noble/ed25519");
    const { sha512 } = await import("@noble/hashes/sha512");
    (ed25519 as unknown as Record<string, Record<string, unknown>>).etc.sha512Sync = sha512;
    edSign = ed25519.signAsync ?? ed25519.sign;
  } catch {
    return {
      success: false,
      error:
        "Ed25519 signing requires @noble/ed25519 and @noble/hashes. Install: npm install @noble/ed25519 @noble/hashes",
    };
  }

  const {
    payerParty,
    payeeParty,
    amount,
    resourceId,
    privateKey,
    keyFingerprint,
  } = options;

  // 1. Get holdings
  const holdingCids = await client.getPayerHoldings(
    payerParty,
    config.spliceHoldingPackageId,
  );
  if (holdingCids.length === 0) {
    return {
      success: false,
      error: `No Amulet holdings found for payer ${payerParty}.`,
    };
  }

  // 2. Get TransferFactory
  const token = await auth.getToken();
  const userId = auth.getUserId();
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
          sender: payerParty,
          receiver: payeeParty,
          amount,
          instrumentId: { id: "Amulet", admin: config.dsoParty },
          lock: null,
          requestedAt: new Date().toISOString(),
          executeBefore: new Date(Date.now() + 3600000).toISOString(),
          inputHoldingCids: holdingCids,
          meta: {
            values: {
              "splice.lfdecentralizedtrust.org/reason": `x402 payment for ${resourceId}`,
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
    return {
      success: false,
      error: `TransferFactory API failed: ${factoryResponse.status} - ${errorText}`,
    };
  }

  const factoryData = (await factoryResponse.json()) as {
    factoryId: string;
    choiceContext?: { disclosedContracts?: unknown[]; [k: string]: unknown };
  };
  const factoryId = factoryData.factoryId;
  const choiceContext = factoryData.choiceContext ?? {};
  const disclosedContracts =
    (choiceContext as Record<string, unknown>).disclosedContracts ?? [];
  const synchronizerId = `global-domain::${config.dsoParty.split("::")[1]}`;
  const commandId = `x402-settle-${Date.now()}`;

  // 3. Prepare transaction
  const prepareResponse = await fetch(
    `${config.ledgerApiUrl}/v2/interactive-submission/prepare`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId,
        actAs: [payerParty],
        readAs: [payerParty, config.dsoParty, payeeParty],
        commandId,
        synchronizerId,
        commands: [
          {
            ExerciseCommand: {
              templateId:
                "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory",
              contractId: factoryId,
              choice: "TransferFactory_Transfer",
              choiceArgument: {
                expectedAdmin: config.dsoParty,
                transfer: {
                  sender: payerParty,
                  receiver: payeeParty,
                  amount,
                  instrumentId: { id: "Amulet", admin: config.dsoParty },
                  lock: null,
                  requestedAt: new Date().toISOString(),
                  executeBefore: new Date(Date.now() + 3600000).toISOString(),
                  inputHoldingCids: holdingCids,
                  meta: {
                    values: {
                      "splice.lfdecentralizedtrust.org/reason": `x402 payment for ${resourceId}`,
                    },
                  },
                },
                extraArgs: {
                  context:
                    (choiceContext as Record<string, unknown>)
                      .choiceContextData ??
                    choiceContext ??
                    { values: {} },
                  meta: { values: {} },
                },
              },
            },
          },
        ],
        disclosedContracts,
        hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
        packageIdSelectionPreference: [],
      }),
    },
  );

  if (!prepareResponse.ok) {
    const errorText = await prepareResponse.text();
    return {
      success: false,
      error: `Prepare failed: ${prepareResponse.status} ${errorText}`,
    };
  }

  const prepareData = (await prepareResponse.json()) as {
    preparedTransactionHash: string;
    preparedTransaction: string;
  };

  // 4. Sign
  const hashBytes = Uint8Array.from(
    Buffer.from(prepareData.preparedTransactionHash, "base64"),
  );
  const privateKeyBytes = Uint8Array.from(
    Buffer.from(privateKey, "base64"),
  );
  const signatureBytes = await edSign(hashBytes, privateKeyBytes);
  const signatureBase64 = Buffer.from(signatureBytes).toString("base64");

  // 5. Execute
  const executeResponse = await fetch(
    `${config.ledgerApiUrl}/v2/interactive-submission/executeAndWaitForTransaction`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        preparedTransaction: prepareData.preparedTransaction,
        partySignatures: {
          signatures: [
            {
              party: payerParty,
              signatures: [
                {
                  format: "SIGNATURE_FORMAT_CONCAT",
                  signature: signatureBase64,
                  signedBy: keyFingerprint,
                  signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519",
                },
              ],
            },
          ],
        },
        deduplicationPeriod: {
          DeduplicationDuration: { value: { seconds: 300, nanos: 0 } },
        },
        submissionId: randomUUID(),
        userId,
        hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
      }),
    },
  );

  if (!executeResponse.ok) {
    const errorText = await executeResponse.text();
    return {
      success: false,
      error: `Execute failed: ${executeResponse.status} ${errorText}`,
    };
  }

  const executeData = (await executeResponse.json()) as {
    updateId?: string;
    transaction?: { updateId?: string };
  };
  const updateId =
    executeData.updateId ?? executeData.transaction?.updateId ?? "unknown";

  return { success: true, transactionId: updateId };
}
