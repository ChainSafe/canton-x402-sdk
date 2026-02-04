// Canton x402 SDK -- Payment Verification

import type {
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  CantonPayload,
  CreatePaymentCommand,
} from "../types.js";
import type { CantonJsonClient } from "./json-client.js";
import { isValidPartyId, isValidAmount, isValidResourceId } from "./validation.js";

const SUPPORTED_SCHEME = "exact-canton";
const SUPPORTED_NETWORKS = [
  "canton-local",
  "canton-testnet",
  "canton-mainnet",
  "canton-devnet",
];

export interface VerifyOptions {
  /** Skip on-ledger transaction check (for unit testing / localnet without tx) */
  skipLedgerCheck?: boolean;
}

/**
 * Verify a Canton x402 payment payload against requirements.
 *
 * Checks: scheme, network, payload structure, required fields,
 * payee/resource match, amount, currency, nonce presence, expiry,
 * input format validation, and on-chain transaction proof.
 */
export async function verify(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  client?: CantonJsonClient,
  options?: VerifyOptions,
): Promise<VerifyResponse> {
  try {
    if (payload.scheme !== SUPPORTED_SCHEME) {
      return { isValid: false, invalidReason: "unsupported_scheme" };
    }
    if (requirements.scheme !== SUPPORTED_SCHEME) {
      return {
        isValid: false,
        invalidReason: "unsupported_scheme_in_requirements",
      };
    }
    if (!SUPPORTED_NETWORKS.includes(payload.network)) {
      return { isValid: false, invalidReason: "unsupported_network" };
    }
    if (!SUPPORTED_NETWORKS.includes(requirements.network)) {
      return {
        isValid: false,
        invalidReason: "unsupported_network_in_requirements",
      };
    }
    if (payload.network !== requirements.network) {
      return { isValid: false, invalidReason: "network_mismatch" };
    }

    const cantonPayload = payload.payload as CantonPayload;
    if (!cantonPayload || !cantonPayload.command) {
      return { isValid: false, invalidReason: "invalid_payload_structure" };
    }

    const cmd = cantonPayload.command;

    if (
      !cmd.payer ||
      !cmd.payee ||
      !cmd.amount ||
      !cmd.currency ||
      !cmd.resourceId ||
      !cmd.nonce
    ) {
      return {
        isValid: false,
        invalidReason: "missing_required_fields",
        payer: cmd.payer,
      };
    }

    // Input format validation
    if (!isValidPartyId(cmd.payer)) {
      return {
        isValid: false,
        invalidReason: "invalid_payer_format",
        payer: cmd.payer,
      };
    }
    if (!isValidPartyId(cmd.payee)) {
      return {
        isValid: false,
        invalidReason: "invalid_payee_format",
        payer: cmd.payer,
      };
    }
    if (!isValidAmount(cmd.amount)) {
      return {
        isValid: false,
        invalidReason: "invalid_amount_format",
        payer: cmd.payer,
      };
    }
    if (!isValidResourceId(cmd.resourceId)) {
      return {
        isValid: false,
        invalidReason: "invalid_resource_id_format",
        payer: cmd.payer,
      };
    }

    if (cmd.payee !== requirements.payTo) {
      return {
        isValid: false,
        invalidReason: "payee_mismatch",
        payer: cmd.payer,
      };
    }
    if (cmd.resourceId !== requirements.resource) {
      return {
        isValid: false,
        invalidReason: "resource_mismatch",
        payer: cmd.payer,
      };
    }

    const paymentAmount = parseFloat(cmd.amount);
    const requiredAmount = parseFloat(requirements.maxAmountRequired);
    if (isNaN(paymentAmount) || isNaN(requiredAmount)) {
      return {
        isValid: false,
        invalidReason: "invalid_amount_format",
        payer: cmd.payer,
      };
    }
    if (paymentAmount < requiredAmount) {
      return {
        isValid: false,
        invalidReason: "insufficient_amount",
        payer: cmd.payer,
      };
    }
    if (paymentAmount <= 0) {
      return {
        isValid: false,
        invalidReason: "invalid_amount_non_positive",
        payer: cmd.payer,
      };
    }
    if (requirements.asset && cmd.currency !== requirements.asset) {
      return {
        isValid: false,
        invalidReason: "currency_mismatch",
        payer: cmd.payer,
      };
    }
    if (!cmd.nonce || cmd.nonce.trim() === "") {
      return {
        isValid: false,
        invalidReason: "missing_or_empty_nonce",
        payer: cmd.payer,
      };
    }

    // Expiry enforcement
    if (cmd.expiresAt) {
      const expiryTime = new Date(cmd.expiresAt).getTime();
      if (isNaN(expiryTime)) {
        return {
          isValid: false,
          invalidReason: "invalid_expiry_format",
          payer: cmd.payer,
        };
      }
      if (Date.now() > expiryTime) {
        return {
          isValid: false,
          invalidReason: "payment_expired",
          payer: cmd.payer,
        };
      }
    }

    // On-chain transaction proof verification
    if (client && cmd.transactionId && !options?.skipLedgerCheck) {
      try {
        const txData = (await client.getTransactionById(cmd.transactionId, [
          cmd.payer,
          cmd.payee,
        ])) as { transaction?: { events?: unknown[] } };

        const transaction = txData.transaction;
        if (!transaction) {
          return {
            isValid: false,
            invalidReason: "transaction_not_found",
            payer: cmd.payer,
          };
        }

        // Verify a matching transfer event exists on-ledger
        const events = (transaction.events ?? []) as Record<string, unknown>[];
        let matchFound = false;
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
            const args = exercisedEvent.choiceArgument as Record<
              string,
              unknown
            >;
            const eventAmount = parseFloat(String(args?.amount ?? ""));
            const witnessParties = (exercisedEvent.witnessParties ??
              []) as string[];
            if (
              !isNaN(eventAmount) &&
              Math.abs(eventAmount - paymentAmount) < 0.0001 &&
              witnessParties.includes(cmd.payee)
            ) {
              matchFound = true;
              break;
            }
          }
        }

        if (!matchFound) {
          return {
            isValid: false,
            invalidReason: "transaction_mismatch",
            payer: cmd.payer,
          };
        }
      } catch {
        return {
          isValid: false,
          invalidReason: "ledger_check_failed",
          payer: cmd.payer,
        };
      }
    }

    return { isValid: true, payer: cmd.payer };
  } catch {
    return { isValid: false, invalidReason: "verification_error" };
  }
}

/**
 * Validate a payment command structure (well-formedness check).
 */
export function validatePaymentCommand(
  command: CreatePaymentCommand,
): { valid: boolean; error?: string } {
  if (!command.payer || typeof command.payer !== "string")
    return { valid: false, error: "Invalid payer party" };
  if (!command.payee || typeof command.payee !== "string")
    return { valid: false, error: "Invalid payee party" };
  if (!command.amount || typeof command.amount !== "string")
    return { valid: false, error: "Invalid amount" };
  const amount = parseFloat(command.amount);
  if (isNaN(amount) || amount <= 0)
    return { valid: false, error: "Amount must be a positive number" };
  if (!command.currency || typeof command.currency !== "string")
    return { valid: false, error: "Invalid currency" };
  if (!command.resourceId || typeof command.resourceId !== "string")
    return { valid: false, error: "Invalid resource ID" };
  if (!command.nonce || typeof command.nonce !== "string")
    return { valid: false, error: "Invalid nonce" };
  return { valid: true };
}
