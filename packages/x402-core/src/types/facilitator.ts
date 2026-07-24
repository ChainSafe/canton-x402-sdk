import * as v from "valibot";
import { CantonPaymentPayloadSchema, X402PaymentEnvelopeSchema } from "./payment";
import { CantonPaymentRequirementsSchema } from "./requirements";
import type { AssetSpec, NetworkId, X402Version } from "./common";
import type { CantonPaymentInner, X402PaymentPayload } from "./payment";
import type { X402PaymentRequirements } from "./requirements";

/**
 * Generic request body for POST /v2/verify and /v2/settle — payload + requirements,
 * parameterized by the same scheme seams. Generic → type-only; the concrete
 * exact-canton request below is schema-first.
 */
export interface X402Request<
  TInner = CantonPaymentInner,
  TAsset = AssetSpec,
  TExtra = Record<string, unknown>,
> {
  x402Version: X402Version;
  paymentPayload: X402PaymentPayload<TInner>;
  paymentRequirements: X402PaymentRequirements<TAsset, TExtra>;
}

/** exact-canton verify/settle request. Settle takes the identical envelope. */
export const VerifyRequestSchema = v.object({
  x402Version: v.literal(2),
  paymentPayload: CantonPaymentPayloadSchema,
  paymentRequirements: CantonPaymentRequirementsSchema,
});
export type VerifyRequest = v.InferOutput<typeof VerifyRequestSchema>;
export type SettleRequest = VerifyRequest;

/** exact-canton verify/settle request guard + parser (schema-derived, concrete). */
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
 * {@link isCantonVerifyRequest} for exact-canton).
 */
const X402RequestEnvelopeSchema = v.looseObject({
  x402Version: v.literal(2),
  paymentPayload: X402PaymentEnvelopeSchema,
  paymentRequirements: v.looseObject({
    scheme: v.pipe(v.string(), v.minLength(1)),
    network: v.string(),
    maxAmountRequired: v.pipe(v.string(), v.minLength(1)),
    payTo: v.pipe(v.string(), v.minLength(1)),
    nonce: v.pipe(v.string(), v.minLength(1)),
    validBefore: v.pipe(v.string(), v.minLength(1)),
    asset: v.looseObject({}),
  }),
});
export function isX402Request(x: unknown): x is X402Request<unknown> {
  return v.is(X402RequestEnvelopeSchema, x);
}
export function parseX402Request(input: unknown): X402Request<unknown> {
  return v.parse(X402RequestEnvelopeSchema, input) as unknown as X402Request<unknown>;
}

/**
 * The pure verification contract every scheme implements. Core owns it as the
 * single source of truth; the facilitator and any client conform to it. Method
 * interface → type-only.
 *
 * The params are the widest envelope (`unknown` inner/asset), so a heterogeneous
 * registry of verifiers type-checks and each verifier narrows via its own guard.
 */
export interface SchemeVerifier {
  readonly schemeId: string;
  /** The concrete network this verifier is bound to, e.g. `canton:<synchronizer>`. */
  readonly networkId: NetworkId;
  verify(
    payload: X402PaymentPayload<unknown>,
    requirements: X402PaymentRequirements<unknown>,
  ): VerifyResponse;
}

export const VerifyInvalidReasonSchema = v.picklist([
  "scheme_mismatch",
  "network_mismatch",
  "requirements_expired",
  "requirements_hash_mismatch",
  "bad_fingerprint",
  "bad_signature",
  "nonce_replayed",
  "missing_public_key",
  /** The signed prepared transaction does not transfer what the requirements demand. */
  "transfer_mismatch",
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

export const SettleErrorReasonSchema = v.picklist([
  "bad_request",
  "unauthorized",
  "scheme_mismatch",
  "network_mismatch",
  "requirements_expired",
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
