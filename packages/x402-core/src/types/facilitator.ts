import * as v from "valibot";
import { CantonPaymentPayloadSchema, X402PaymentEnvelopeSchema } from "./payment";
import {
  CantonPaymentRequirementsSchema,
  X402PaymentRequirementsEnvelopeSchema,
} from "./requirements";
import type { NetworkId, X402Version } from "./common";
import type { CantonPaymentInner, X402PaymentPayload } from "./payment";
import type { X402PaymentRequirements } from "./requirements";

/**
 * Generic request body for POST /v2/verify and /v2/settle — payload + requirements,
 * parameterized by the same scheme seams: `TExtra` is both the requirements' and
 * the payment's `accepted`'s. Generic → type-only; the concrete canton-exact
 * request below is schema-first.
 */
export interface X402Request<TInner = CantonPaymentInner, TExtra = Record<string, unknown>> {
  x402Version: X402Version;
  paymentPayload: X402PaymentPayload<TInner, TExtra>;
  paymentRequirements: X402PaymentRequirements<TExtra>;
}

/** canton-exact verify/settle request. Settle takes the identical envelope. */
export const VerifyRequestSchema = v.object({
  x402Version: v.literal(2),
  paymentPayload: CantonPaymentPayloadSchema,
  paymentRequirements: CantonPaymentRequirementsSchema,
});
export type VerifyRequest = v.InferOutput<typeof VerifyRequestSchema>;
export type SettleRequest = VerifyRequest;

/** canton-exact verify/settle request guard + parser (schema-derived, concrete). */
export function isCantonVerifyRequest(x: unknown): x is VerifyRequest {
  return v.is(VerifyRequestSchema, x);
}
export function parseCantonVerifyRequest(input: unknown): VerifyRequest {
  return v.parse(VerifyRequestSchema, input);
}

/**
 * Loose validator for the verify/settle request envelope: the universal fields
 * only — x402 v2, a payment envelope, and the requirements fields shared by every
 * scheme. Scheme-agnostic: a multi-scheme dispatcher validates/parses the envelope
 * with this, then the per-scheme verifier checks the concrete inner (use
 * {@link isCantonVerifyRequest} for canton-exact).
 */
const X402RequestEnvelopeSchema = v.looseObject({
  x402Version: v.literal(2),
  paymentPayload: X402PaymentEnvelopeSchema,
  paymentRequirements: X402PaymentRequirementsEnvelopeSchema,
});
export function isX402Request(x: unknown): x is X402Request<unknown, unknown> {
  return v.is(X402RequestEnvelopeSchema, x);
}
export function parseX402Request(input: unknown): X402Request<unknown, unknown> {
  return v.parse(X402RequestEnvelopeSchema, input) as unknown as X402Request<unknown, unknown>;
}

/**
 * The pure verification contract every scheme implements. Core owns it as the
 * single source of truth; the facilitator and any client conform to it. Method
 * interface → type-only.
 *
 * The params are the widest envelope (`unknown` inner and `extra`), so a heterogeneous
 * registry of verifiers type-checks and each verifier narrows via its own guard.
 */
export interface SchemeVerifier {
  readonly schemeId: string;
  /** The concrete network this verifier is bound to, e.g. `canton:devnet`. */
  readonly networkId: NetworkId;
  verify(
    payload: X402PaymentPayload<unknown, unknown>,
    requirements: X402PaymentRequirements<unknown>,
  ): Promise<VerifyResponse>;
}

/**
 * The reason codes the specs define: the Canton `exact` scheme's Error Reason
 * Codes table, then the x402 v2 general codes (§9) other than the EVM scheme's.
 * The scheme's table is not split by endpoint, so verify and settle both take
 * all of them.
 */
const SPEC_REASONS = [
  "invalid_exact_canton_missing_proof",
  "invalid_exact_canton_malformed_payload",
  "invalid_exact_canton_signature_invalid",
  "invalid_exact_canton_amount_mismatch",
  "invalid_exact_canton_merchant_mismatch",
  "invalid_exact_canton_instrument_id_mismatch",
  "invalid_exact_canton_preapproval_missing",
  "invalid_exact_canton_fee_payer_mismatch",
  "invalid_exact_canton_expired",
  "invalid_exact_canton_execute_before_too_far",
  "invalid_exact_canton_insufficient_inputs",
  "invalid_exact_canton_memo_mismatch",
  "invalid_exact_canton_merchant_not_registered",
  "invalid_exact_canton_self_payment",
  "invalid_exact_canton_execute_failed",
  "unexpected_canton_ledger_error",
  "settlement_pending",
  "invalid_network",
  "unsupported_scheme",
  "insufficient_funds",
  "invalid_payload",
  "invalid_payment_requirements",
  "invalid_scheme",
  "invalid_x402_version",
  "invalid_transaction_state",
  "unexpected_verify_error",
  "unexpected_settle_error",
] as const;

/**
 * Why a payment is invalid. The verifier answers with the spec's code, the one
 * a client written against the spec matches on, and carries the code it
 * answered with before in `extensions.reason`. Those older codes stay in the
 * union, below the spec's, so an answer from a facilitator on an older core
 * still parses; dropping them is a separate, breaking change.
 */
export const VerifyInvalidReasonSchema = v.picklist([
  ...SPEC_REASONS,
  "scheme_mismatch",
  "network_mismatch",
  /**
   * Nothing produces this any more: the payload carries no `requirementsHash`
   * to check. It stays with the other older codes until they are dropped.
   */
  "requirements_hash_mismatch",
  "bad_fingerprint",
  "bad_signature",
  "prepared_transaction_hash_mismatch",
  "invalid_prepared_transaction_structure",
  "nonce_replayed",
  "missing_public_key",
  /** The signed prepared transaction does not transfer what the requirements demand. */
  "transfer_mismatch",
  /**
   * The signed transfer's own `executeBefore` has passed, is about to, or is
   * missing — so it cannot settle, and the client should prepare another. The
   * only expiry left: a quote no longer goes stale on its own, because the
   * deadline that decides is the one inside what the payer signed.
   */
  "transfer_expired",
  "internal_error",
]);
export type VerifyInvalidReason = v.InferOutput<typeof VerifyInvalidReasonSchema>;

/** Scheme-specific extra fields (mirrors upstream x402 v2 `extensions`). */
const ExtensionsSchema = v.record(v.string(), v.unknown());

export const VerifyResponseValidSchema = v.object({
  isValid: v.literal(true),
  payer: v.optional(v.string()),
  extensions: v.optional(ExtensionsSchema),
});
export type VerifyResponseValid = v.InferOutput<typeof VerifyResponseValidSchema>;

export const VerifyResponseInvalidSchema = v.object({
  isValid: v.literal(false),
  invalidReason: VerifyInvalidReasonSchema,
  payer: v.optional(v.string()),
  extensions: v.optional(ExtensionsSchema),
});
export type VerifyResponseInvalid = v.InferOutput<typeof VerifyResponseInvalidSchema>;

/** Discriminated on `isValid`. */
export const VerifyResponseSchema = v.variant("isValid", [
  VerifyResponseValidSchema,
  VerifyResponseInvalidSchema,
]);
export type VerifyResponse = v.InferOutput<typeof VerifyResponseSchema>;

/** Why a settle failed: the spec's codes, then this facilitator's own. */
export const SettleErrorReasonSchema = v.picklist([
  ...SPEC_REASONS,
  "bad_request",
  "unauthorized",
  "scheme_mismatch",
  "network_mismatch",
  /** As in {@link VerifyInvalidReasonSchema}: unproducible, kept with the older codes. */
  "requirements_hash_mismatch",
  "bad_fingerprint",
  "bad_signature",
  "nonce_replayed",
  "execution_failed",
  "timeout",
  "facilitator_error",
]);
export type SettleErrorReason = v.InferOutput<typeof SettleErrorReasonSchema>;

export const SettleResponseSuccessSchema = v.object({
  success: v.literal(true),
  network: v.string(),
  /** Canton updateId of the executed transaction. */
  transaction: v.string(),
  completionOffset: v.optional(v.string()),
  payer: v.string(),
  extensions: v.optional(ExtensionsSchema),
});
export type SettleResponseSuccess = v.InferOutput<typeof SettleResponseSuccessSchema>;

export const SettleResponseErrorSchema = v.object({
  success: v.literal(false),
  errorReason: SettleErrorReasonSchema,
  errorDetails: v.optional(v.string()),
});
export type SettleResponseError = v.InferOutput<typeof SettleResponseErrorSchema>;

/** Discriminated on `success`. */
export const SettleResponseSchema = v.variant("success", [
  SettleResponseSuccessSchema,
  SettleResponseErrorSchema,
]);
export type SettleResponse = v.InferOutput<typeof SettleResponseSchema>;

export const SupportedKindSchema = v.object({
  x402Version: v.literal(2),
  scheme: v.string(),
  network: v.string(),
  extra: v.optional(ExtensionsSchema),
});
export type SupportedKind = v.InferOutput<typeof SupportedKindSchema>;

export const SupportedResponseSchema = v.object({
  kinds: v.array(SupportedKindSchema),
});
export type SupportedResponse = v.InferOutput<typeof SupportedResponseSchema>;
