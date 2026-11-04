import * as v from "valibot";
import { InstrumentIdSchema } from "./common";
import type { NetworkId, Scheme, X402Version } from "./common";

/**
 * Generic PaymentRequirements — the merchant's 402 offer. `TExtra` is the one
 * scheme-specific seam; every other field is shared, including `asset`, which
 * the spec types as a string for every scheme (a token contract address on EVM,
 * a symbol here). Anything an asset cannot say as a string belongs in `extra`.
 * `scheme` is the open {@link Scheme} union so schemes share the envelope.
 * Generic → type-only (the concrete Canton shape below is schema-first).
 */
export interface X402PaymentRequirements<TExtra = Record<string, unknown>> {
  scheme: Scheme;
  network: NetworkId;
  /**
   * Maximum amount to charge, as a decimal string denominated in `asset`.
   * Precision is scheme-defined.
   */
  amount: string;
  /** Asset identifier. A symbol here (`"CC"`); a token address on EVM. */
  asset: string;
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

/** A required string field: present and not empty. */
const nonEmptyString = v.pipe(v.string(), v.minLength(1));

/**
 * The canton-exact `extra`. `looseObject`, so the keys the spec defines are
 * named and typed while anything else a deployment adds still passes through —
 * `extra` is the per-scheme extension point and closing it would defeat that.
 *
 * `instrumentId` is required here because `asset` is only a symbol: `"CC"` says
 * Canton Coin but not which registry issued it, and the verifier binds the
 * transfer's instrument against this.
 */
export const CantonRequirementsExtraSchema = v.looseObject({
  instrumentId: InstrumentIdSchema,
});
export type CantonRequirementsExtra = v.InferOutput<typeof CantonRequirementsExtraSchema>;

/**
 * canton-exact requirements, sent in the 402's accepts[]. Schema-first — the
 * concrete shape, its validator, and its type are one definition.
 */
export const CantonPaymentRequirementsSchema = v.object({
  // Every required string is non-empty. Without that the CONCRETE guard was
  // looser than the ENVELOPE one, which is backwards: `asset: ""` passed
  // isCantonPaymentRequirements and failed isX402PaymentRequirements.
  scheme: nonEmptyString,
  network: nonEmptyString,
  amount: nonEmptyString,
  /** A symbol: `"CC"`, or a registry token's own. The instrument is in `extra`. */
  asset: nonEmptyString,
  payTo: nonEmptyString,
  resource: nonEmptyString,
  description: v.optional(v.string()),
  nonce: nonEmptyString,
  validBefore: nonEmptyString,
  maxTimeoutSeconds: v.optional(v.number()),
  extra: CantonRequirementsExtraSchema,
});
export type CantonPaymentRequirements = v.InferOutput<typeof CantonPaymentRequirementsSchema>;

/** canton-exact requirements guard + parser (schema-derived). */
export function isCantonPaymentRequirements(x: unknown): x is CantonPaymentRequirements {
  return v.is(CantonPaymentRequirementsSchema, x);
}
export function parseCantonPaymentRequirements(input: unknown): CantonPaymentRequirements {
  return v.parse(CantonPaymentRequirementsSchema, input);
}

/**
 * Loose validator for the requirements envelope: the universal fields every scheme
 * shares, with a scheme-agnostic `asset` object (the concrete asset shape is the
 * per-scheme seam). `looseObject` so a scheme's extra keys pass through. Mirrors
 * {@link isX402PaymentPayload} — envelope-level validation only; the per-scheme
 * verifier checks the concrete asset (use {@link isCantonPaymentRequirements} for
 * canton-exact). This is the requirements shape carried in the X402 request +
 * X-PAYMENT envelopes.
 */
export const X402PaymentRequirementsEnvelopeSchema = v.looseObject({
  scheme: nonEmptyString,
  network: nonEmptyString,
  amount: nonEmptyString,
  payTo: nonEmptyString,
  nonce: nonEmptyString,
  validBefore: nonEmptyString,
  asset: nonEmptyString,
});

export function isX402PaymentRequirements(x: unknown): x is X402PaymentRequirements<unknown> {
  return v.is(X402PaymentRequirementsEnvelopeSchema, x);
}

/**
 * The `402 Payment Required` response body — returned by the merchant/resource
 * server, listing the payment options the client may satisfy. The client picks
 * one of `accepts[]`, pays it, and retries the request with the `X-PAYMENT`
 * header. Produced by the merchant middleware; parsed by the auto-pay client.
 *
 * Generic over the `accepts[]` element (`TRequirements`) so a mixed-scheme offer
 * (e.g. canton-exact + a bridge scheme) is expressible as a union; every other
 * field is shared. Generic → type-only.
 */
export interface X402PaymentRequiredResponse<TRequirements = CantonPaymentRequirements> {
  x402Version: X402Version;
  /** Payment options; the client satisfies exactly one of them. */
  accepts: TRequirements[];
  /** Optional machine-readable reason, e.g. "payment_required". */
  error?: string;
}

/** canton-exact 402 response: `accepts[]` of {@link CantonPaymentRequirements}. */
export const CantonPaymentRequiredResponseSchema = v.object({
  x402Version: v.literal(2),
  accepts: v.array(CantonPaymentRequirementsSchema),
  error: v.optional(v.string()),
});

export type CantonPaymentRequiredResponse = v.InferOutput<
  typeof CantonPaymentRequiredResponseSchema
>;
