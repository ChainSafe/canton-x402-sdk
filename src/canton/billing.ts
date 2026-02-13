// Canton x402 SDK -- On-Chain Billing Module
//
// Provides functions to query payments and charges from Canton blockchain,
// create charge receipts, and compute balances.

import type { AuthProvider } from "./auth.js";
import { CantonJsonClient } from "./json-client.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChargeRecord {
  contractId: string;
  tool: string;
  amount: number;
  requestId: string;
  description: string;
  timestamp: string;
  user: string;
  provider: string;
}

export interface PaymentRecord {
  transactionId: string;
  amount: number;
  timestamp: string;
  payer: string;
  payee: string;
}

export interface BalanceResult {
  party: string;
  totalPaid: number;
  totalCharged: number;
  balance: number; // totalPaid - totalCharged (positive = credit available)
  lastSync: string;
  payments: PaymentRecord[];
  charges: ChargeRecord[];
}

export interface BalanceOptions {
  payerParty: string;
  payeeParty: string;
  providerParty: string;
  chargeReceiptPackageId: string;
}

export interface CreateChargeOptions {
  providerParty: string;
  userParty: string;
  tool: string;
  amount: number;
  requestId: string;
  description?: string;
  packageId: string;
  chargeManagerContractId: string;
}

export interface CreateChargeResult {
  contractId: string;
  transactionId: string;
}

export interface QueryResult<T> {
  total: number;
  items: T[];
}

// ─── Query Payments from Chain ──────────────────────────────────────────────

/**
 * Query payments (top-ups) made by a user to the service provider.
 *
 * Note: On Canton localnet, payments are tracked via the facilitator/wallet flow.
 * This function queries PaymentReceipt contracts created when users top up their balance.
 *
 * For MVP, we return 0 payments and rely on the threshold-based billing model
 * where users can accrue charges up to a limit before payment is required.
 */
export async function queryPaymentsFromChain(
  ledgerUrl: string,
  auth: AuthProvider,
  payerParty: string,
  payeeParty: string,
  options?: {
    fromOffset?: string;
    limit?: number;
  },
): Promise<QueryResult<PaymentRecord>> {
  // For MVP on localnet: Return empty payments
  // Users start with 0 balance and accrue charges (negative balance = debt)
  // The billing system uses a threshold model (-2.0 CC default) before blocking
  //
  // Future enhancement: Query PaymentReceipt contracts or transaction history
  // when the Canton JSON API v2 updates endpoint is available

  const payments: PaymentRecord[] = [];

  // Log for debugging
  console.log(`[billing] queryPaymentsFromChain: Returning 0 payments (MVP mode)`);
  console.log(`[billing] Payer: ${payerParty.substring(0, 30)}...`);
  console.log(`[billing] Payee: ${payeeParty.substring(0, 30)}...`);

  return {
    total: 0,
    items: payments,
  };
}

// ─── Query Charges from Chain ───────────────────────────────────────────────

/**
 * Query ChargeReceipt contracts for a user from the Canton ledger.
 *
 * Queries active ChargeReceipt contracts from the PROVIDER's perspective
 * (since the OAuth token has access to provider's contracts), then filters
 * by user in the results.
 */
export async function queryChargesFromChain(
  ledgerUrl: string,
  auth: AuthProvider,
  providerParty: string,
  userParty: string,
  packageId: string,
): Promise<QueryResult<ChargeRecord>> {
  const client = new CantonJsonClient(ledgerUrl, auth);
  const charges: ChargeRecord[] = [];

  console.log(`[billing] queryChargesFromChain: Querying for provider=${providerParty.substring(0, 30)}...`);
  console.log(`[billing] queryChargesFromChain: Filtering for user=${userParty.substring(0, 30)}...`);
  console.log(`[billing] queryChargesFromChain: Package ID=${packageId}`);

  // Query active ChargeReceipt contracts from PROVIDER's perspective
  // The provider is the signatory and has visibility to all their ChargeReceipts
  // We then filter by user in the results
  const entries = await client.getActiveContracts(providerParty, {
    filtersByParty: {
      [providerParty]: {
        filters: [
          {
            templateFilter: {
              templateId: `${packageId}:MCP.Billing:ChargeReceipt`,
              includeCreatedEventBlob: false,
            },
          },
        ],
      },
    },
  });

  for (const entry of entries) {
    const e = entry as Record<string, unknown>;
    const contract =
      (e.contractEntry as Record<string, unknown>)?.JsActiveContract ??
      (e.contractEntry as Record<string, unknown>)?.activeContract ??
      (e as Record<string, unknown>).JsActiveContract ??
      (e as Record<string, unknown>).activeContract ??
      (e.createdEvent ? e : null);

    if (!contract) continue;

    const c = contract as Record<string, unknown>;
    const createdEvent = c.createdEvent as Record<string, unknown> | undefined;
    const cid = (createdEvent?.contractId ?? c.contractId) as string | undefined;
    const payload = (createdEvent?.createArguments ?? c.createArguments ?? c.payload) as Record<string, unknown> | undefined;

    if (!cid || !payload) continue;

    // Verify this is for our provider
    const chargeProvider = String(payload.provider ?? "");
    if (chargeProvider !== providerParty) continue;

    // Filter by user if specified (query returns all provider's charges)
    const chargeUser = String(payload.user ?? "");
    if (userParty && chargeUser !== userParty) continue;

    charges.push({
      contractId: cid,
      tool: String(payload.tool ?? ""),
      amount: parseFloat(String(payload.amount ?? "0")),
      requestId: String(payload.requestId ?? ""),
      description: String(payload.description ?? ""),
      timestamp: String(payload.timestamp ?? ""),
      user: String(payload.user ?? ""),
      provider: chargeProvider,
    });
  }

  const totalCharged = charges.reduce((sum, c) => sum + c.amount, 0);
  console.log(`[billing] queryChargesFromChain: Found ${charges.length} charges totaling ${totalCharged} CC`);

  return {
    total: totalCharged,
    items: charges,
  };
}

// ─── Create Charge Receipt ──────────────────────────────────────────────────

/**
 * Create a ChargeReceipt contract on the Canton ledger.
 *
 * Uses the ChargeManager contract to create charges via the CreateCharge choice.
 */
export async function createChargeReceipt(
  ledgerUrl: string,
  auth: AuthProvider,
  options: CreateChargeOptions,
): Promise<CreateChargeResult> {
  const token = await auth.getToken();
  const userId = auth.getUserId();

  // Use the ChargeManager's CreateCharge nonconsuming choice
  const command = {
    userId,
    commandId: `charge-${options.requestId}-${Date.now()}`,
    commands: [
      {
        exerciseCommand: {
          templateId: `${options.packageId}:MCP.Billing:ChargeManager`,
          contractId: options.chargeManagerContractId,
          choice: "CreateCharge",
          choiceArgument: {
            chargeUser: options.userParty,
            chargeTool: options.tool,
            chargeAmount: String(options.amount),
            chargeRequestId: options.requestId,
            chargeDescription: options.description ?? `MCP tool usage: ${options.tool}`,
          },
        },
      },
    ],
    actAs: [options.providerParty],
    readAs: [options.providerParty],
  };

  const response = await fetch(`${ledgerUrl}/v2/commands/submit-and-wait`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create charge receipt: ${response.status} ${errorText}`);
  }

  const result = (await response.json()) as {
    updateId: string;
    completionOffset: string;
    transaction?: {
      events?: Array<{
        createdEvent?: { contractId: string };
        CreatedEvent?: { contractId: string };
      }>;
    };
  };

  // Extract the created contract ID from the response
  let contractId = "";
  const events = result.transaction?.events ?? [];
  for (const event of events) {
    const created = event.createdEvent ?? event.CreatedEvent;
    if (created?.contractId) {
      contractId = created.contractId;
      break;
    }
  }

  return {
    contractId,
    transactionId: result.updateId,
  };
}

// ─── Compute Balance ────────────────────────────────────────────────────────

/**
 * Compute the balance for a party from chain data.
 *
 * Balance = Total Payments - Total Charges
 * Positive balance means credit available (can use more tools).
 * Negative balance means debt (should pay before using more tools).
 */
export async function computeBalance(
  ledgerUrl: string,
  auth: AuthProvider,
  options: BalanceOptions,
): Promise<BalanceResult> {
  // Query payments from payer to payee
  const paymentsResult = await queryPaymentsFromChain(
    ledgerUrl,
    auth,
    options.payerParty,
    options.payeeParty,
  );

  // Query charges from provider for this user
  const chargesResult = await queryChargesFromChain(
    ledgerUrl,
    auth,
    options.providerParty,
    options.payerParty,
    options.chargeReceiptPackageId,
  );

  const totalPaid = paymentsResult.total;
  const totalCharged = chargesResult.total;
  const balance = totalPaid - totalCharged;

  return {
    party: options.payerParty,
    totalPaid,
    totalCharged,
    balance,
    lastSync: new Date().toISOString(),
    payments: paymentsResult.items,
    charges: chargesResult.items,
  };
}

// ─── Helper: Create ChargeManager Contract ──────────────────────────────────

/**
 * Create a ChargeManager contract for a provider party.
 *
 * This is a one-time setup step that creates the factory contract
 * which can then be used to create ChargeReceipts.
 */
export async function createChargeManager(
  ledgerUrl: string,
  auth: AuthProvider,
  providerParty: string,
  packageId: string,
): Promise<{ contractId: string; transactionId: string }> {
  const token = await auth.getToken();
  const userId = auth.getUserId();

  const command = {
    userId,
    commandId: `create-charge-manager-${Date.now()}`,
    commands: [
      {
        createCommand: {
          templateId: `${packageId}:MCP.Billing:ChargeManager`,
          createArguments: {
            provider: providerParty,
          },
        },
      },
    ],
    actAs: [providerParty],
    readAs: [providerParty],
  };

  const response = await fetch(`${ledgerUrl}/v2/commands/submit-and-wait`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create ChargeManager: ${response.status} ${errorText}`);
  }

  const result = (await response.json()) as {
    updateId: string;
    transaction?: {
      events?: Array<{
        createdEvent?: { contractId: string };
        CreatedEvent?: { contractId: string };
      }>;
    };
  };

  // Extract contract ID
  let contractId = "";
  const events = result.transaction?.events ?? [];
  for (const event of events) {
    const created = event.createdEvent ?? event.CreatedEvent;
    if (created?.contractId) {
      contractId = created.contractId;
      break;
    }
  }

  return {
    contractId,
    transactionId: result.updateId,
  };
}

// ─── Helper: Find ChargeManager Contract ────────────────────────────────────

/**
 * Find an existing ChargeManager contract for a provider party.
 */
export async function findChargeManager(
  ledgerUrl: string,
  auth: AuthProvider,
  providerParty: string,
  packageId: string,
): Promise<string | null> {
  const client = new CantonJsonClient(ledgerUrl, auth);

  const entries = await client.getActiveContracts(providerParty, {
    filtersByParty: {
      [providerParty]: {
        filters: [
          {
            templateFilter: {
              templateId: `${packageId}:MCP.Billing:ChargeManager`,
              includeCreatedEventBlob: false,
            },
          },
        ],
      },
    },
  });

  for (const entry of entries) {
    const e = entry as Record<string, unknown>;
    const contract =
      (e.contractEntry as Record<string, unknown>)?.JsActiveContract ??
      (e.contractEntry as Record<string, unknown>)?.activeContract ??
      (e as Record<string, unknown>).JsActiveContract ??
      (e as Record<string, unknown>).activeContract ??
      (e.createdEvent ? e : null);

    if (!contract) continue;

    const c = contract as Record<string, unknown>;
    const createdEvent = c.createdEvent as Record<string, unknown> | undefined;
    const cid = (createdEvent?.contractId ?? c.contractId) as string | undefined;
    const payload = (createdEvent?.createArguments ?? c.createArguments ?? c.payload) as Record<string, unknown> | undefined;

    if (!cid || !payload) continue;

    // Verify this is for our provider
    if (String(payload.provider ?? "") === providerParty) {
      return cid;
    }
  }

  return null;
}

// ─── Helper: Get or Create ChargeManager ────────────────────────────────────

/**
 * Get an existing ChargeManager or create one if it doesn't exist.
 */
export async function getOrCreateChargeManager(
  ledgerUrl: string,
  auth: AuthProvider,
  providerParty: string,
  packageId: string,
): Promise<string> {
  // Try to find existing
  const existing = await findChargeManager(ledgerUrl, auth, providerParty, packageId);
  if (existing) {
    return existing;
  }

  // Create new
  const result = await createChargeManager(ledgerUrl, auth, providerParty, packageId);
  return result.contractId;
}
