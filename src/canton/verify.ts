// Canton x402 SDK -- Payment Verification

import type {
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  CantonPayload,
  CreatePaymentCommand,
} from "../types.js";

const SUPPORTED_SCHEME = "exact-canton";
const SUPPORTED_NETWORKS = [
  "canton-local",
  "canton-testnet",
  "canton-mainnet",
  "canton-devnet",
];

/**
 * Verify a Canton x402 payment payload against requirements.
 *
 * Checks: scheme, network, payload structure, required fields,
 * payee/resource match, amount, currency, nonce presence.
 */
export async function verify(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
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
