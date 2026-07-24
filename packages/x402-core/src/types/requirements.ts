import * as v from "valibot";
import { AssetSpecSchema } from "./common";
import type { AssetSpec, NetworkId, Scheme, X402Version } from "./common";

/**
 * Generic PaymentRequirements — the merchant's 402 offer. The scheme-specific seams
 * are `TAsset` (the asset descriptor) and `TExtra` (the scheme's `extra` bag); every
 * other field is shared. `scheme` is the open {@link Scheme} union so schemes share
 * the envelope. Generic → type-only (the concrete Canton shape below is schema-first).
 */
export interface X402PaymentRequirements<TAsset = AssetSpec, TExtra = Record<string, unknown>> {
  scheme: Scheme;
  network: NetworkId;
  /**
   * Maximum amount to charge, as a decimal string denominated in `asset`.
   * Precision is scheme-defined.
   */
  maxAmountRequired: string;
  /** The scheme-specific asset descriptor (the `TAsset` seam). */
  asset: TAsset;
  /** Recipient party ID. */
  payTo: string;
  /** Resource URL the wallet is paying for. */
  resource: string;
  description?: string;
  /** Unique nonce; UUID v4 recommended. */
  nonce: string;
  /** ISO 8601 timestamp; facilitator rejects /settle after this. */
  validBefore: string;
  maxTimeoutSeconds?: number;
  /** Scheme-specific extra (the `TExtra` seam), e.g. the bridge's `cantonRecipient`. */
  extra?: TExtra;
}

/**
 * exact-canton requirements: a Splice {@link AssetSpec}, sent in the 402's accepts[].
 * Schema-first — the concrete shape, its validator, and its type are one definition.
 */
export const CantonPaymentRequirementsSchema = v.object({
  scheme: v.string(),
  network: v.string(),
  maxAmountRequired: v.string(),
  asset: AssetSpecSchema,
  payTo: v.string(),
  resource: v.string(),
  description: v.optional(v.string()),
  nonce: v.string(),
  validBefore: v.string(),
  maxTimeoutSeconds: v.optional(v.number()),
  extra: v.optional(v.record(v.string(), v.unknown())),
});
export type CantonPaymentRequirements = v.InferOutput<typeof CantonPaymentRequirementsSchema>;

/** exact-canton requirements guard + parser (schema-derived). */
export function isCantonPaymentRequirements(x: unknown): x is CantonPaymentRequirements {
  return v.is(CantonPaymentRequirementsSchema, x);
}
export function parseCantonPaymentRequirements(input: unknown): CantonPaymentRequirements {
  return v.parse(CantonPaymentRequirementsSchema, input);
}

/**
 * The `402 Payment Required` response body — returned by the merchant/resource
 * server, listing the payment options the client may satisfy. The client picks
 * one of `accepts[]`, pays it, and retries the request with the `X-PAYMENT`
 * header. Produced by the merchant middleware; parsed by the auto-pay client.
 *
 * Generic over the `accepts[]` element (`TRequirements`) so a mixed-scheme offer
 * (e.g. exact-canton + a bridge scheme) is expressible as a union; every other
 * field is shared. Generic → type-only.
 */
export interface X402PaymentRequiredResponse<TRequirements = CantonPaymentRequirements> {
  x402Version: X402Version;
  /** Payment options; the client satisfies exactly one of them. */
  accepts: TRequirements[];
  /** Optional machine-readable reason, e.g. "payment_required". */
  error?: string;
}

/** exact-canton 402 response: `accepts[]` of {@link CantonPaymentRequirements}. */
export const CantonPaymentRequiredResponseSchema = v.object({
  x402Version: v.literal(2),
  accepts: v.array(CantonPaymentRequirementsSchema),
  error: v.optional(v.string()),
});
export type CantonPaymentRequiredResponse = v.InferOutput<typeof CantonPaymentRequiredResponseSchema>;
