import * as v from "valibot";
import {
  ASSET_TRANSFER_METHOD,
  InstrumentIdSchema,
  PaymentExtensionsSchema,
  ResourceInfoSchema,
} from "./common";
import type { NetworkId, PaymentExtensions, ResourceInfo, Scheme, X402Version } from "./common";

/**
 * Generic PaymentRequirements — the merchant's 402 offer. `TExtra` is the one
 * scheme-specific seam; every other field is shared, including `asset`, which
 * the spec types as a string for every scheme (a token contract address on EVM,
 * a symbol here). Anything an asset cannot say as a string belongs in `extra`.
 * `scheme` is the open {@link Scheme} union so schemes share the envelope.
 * Generic → type-only (the concrete Canton shape below is schema-first). A type
 * alias, not an interface, so it keeps an implicit index signature: a payment
 * typed with it as `accepted` still assigns to the schema-inferred
 * `CantonPaymentPayload`, whose `accepted` is a loose object.
 */
export type X402PaymentRequirements<TExtra = Record<string, unknown>> = {
  scheme: Scheme;
  network: NetworkId;
  /**
   * Exact amount to charge, as an integer string in `asset`'s atomic units —
   * on Canton one atomic unit is 1e-10 of the token.
   */
  amount: string;
  /** Asset identifier. A symbol here (`"CC"`); a token address on EVM. */
  asset: string;
  /** Recipient party ID. */
  payTo: string;
  /** Seconds the client has to complete payment. Required for every scheme. */
  maxTimeoutSeconds: number;
  /** Scheme-specific extra (the `TExtra` seam), e.g. the bridge's `cantonRecipient`. */
  extra?: TExtra;
};

/** A required string field: present and not empty. */
const nonEmptyString = v.pipe(v.string(), v.minLength(1));

/**
 * A duration, not merely a number. `v.number()` already refuses NaN but admits
 * `Infinity`, `0` and negatives, none of which are a time a client can be given.
 */
const positiveSeconds = v.pipe(v.number(), v.integer(), v.minValue(1));

/**
 * The merchant's memo: UTF-8, at most 256 BYTES. Bytes, not characters — the
 * limit is on what travels, and an emoji is four of them. The client copies it
 * into the transfer's metadata verbatim, so an empty one would be a key with
 * nothing under it.
 */
const memoString = v.pipe(v.string(), v.minLength(1), v.maxBytes(256));

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
  /**
   * MUST be `transfer-factory`. A reserved protocol key, so it is read as the
   * spec defines it rather than as an opaque scheme-private field — which is
   * why a wrong value is refused here instead of ignored.
   */
  assetTransferMethod: v.literal(ASSET_TRANSFER_METHOD),
  instrumentId: InstrumentIdSchema,
  /**
   * Seconds from request time. The client turns it into the transfer's absolute
   * `executeBefore`, after which the signed transfer is no longer executable —
   * so unlike `maxTimeoutSeconds` this one reaches the ledger, and the verifier
   * refuses a transfer whose deadline is not still ahead of now (Rule 10).
   */
  executeBeforeSeconds: positiveSeconds,
  /**
   * Optional merchant reference. When set, the transfer's metadata MUST carry
   * the identical value under `x402.memo` (Rule 12) — so quoting one makes it
   * part of what the payer signs, not a hint.
   */
  memo: v.optional(memoString),
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
  /** Atomic units as an integer string: 1 token = 1e10, so `"500000000"` is 0.05. */
  amount: nonEmptyString,
  /** A symbol: `"CC"`, or a registry token's own. The instrument is in `extra`. */
  asset: nonEmptyString,
  payTo: nonEmptyString,
  maxTimeoutSeconds: positiveSeconds,
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
 * Loose validator for the requirements envelope: the fields the spec requires of
 * every scheme's `PaymentRequirements`. `looseObject` so a scheme's own keys,
 * `extra` among them, pass through. Mirrors {@link isX402PaymentPayload} —
 * envelope-level validation only; the per-scheme verifier checks the rest (use
 * {@link isCantonPaymentRequirements} for canton-exact). This is the shape of the
 * X402 request's `paymentRequirements`, and of a payment's `accepted`.
 */
export const X402PaymentRequirementsEnvelopeSchema = v.looseObject({
  scheme: nonEmptyString,
  network: nonEmptyString,
  amount: nonEmptyString,
  payTo: nonEmptyString,
  asset: nonEmptyString,
  maxTimeoutSeconds: positiveSeconds,
});

export function isX402PaymentRequirements(x: unknown): x is X402PaymentRequirements<unknown> {
  return v.is(X402PaymentRequirementsEnvelopeSchema, x);
}

/**
 * The x402 v2 `PaymentRequired` object a `402 Payment Required` answers with:
 * one resource, and the ways to pay for it. The client picks one of
 * `accepts[]`, pays it, and retries the request with the `PAYMENT-SIGNATURE` header.
 *
 * The HTTP transport carries it base64-encoded in the `PAYMENT-REQUIRED`
 * response header ({@link encodePaymentRequiredHeader}). The merchant
 * middleware sends it as the body too, with a `details` string beside it.
 *
 * Generic over the `accepts[]` element (`TRequirements`) so a mixed-scheme offer
 * (e.g. canton-exact + a bridge scheme) is expressible as a union; every other
 * field is shared. Generic → type-only.
 */
export interface X402PaymentRequiredResponse<TRequirements = CantonPaymentRequirements> {
  x402Version: X402Version;
  /** What is being paid for. Required by the spec. */
  resource: ResourceInfo;
  /** Payment options; the client satisfies exactly one of them. */
  accepts: TRequirements[];
  /** Optional machine-readable reason, e.g. "payment_required". */
  error?: string;
  extensions?: PaymentExtensions | null;
}

/**
 * Loose validator for a 402's envelope: x402 v2, a `resource` with a `url`,
 * and an `accepts[]` of entries carrying the fields every scheme's
 * requirements share.
 *
 * Deliberately NOT per-scheme, as {@link X402PaymentPayloadEnvelopeSchema} is
 * not: one 402 may offer canton-exact beside another scheme, and checking each
 * entry against canton-exact's shape would throw the whole offer out over an
 * entry this reader was never going to pay. Which entries a payer can satisfy
 * is the payer's question, asked per entry.
 */
export const X402PaymentRequiredResponseEnvelopeSchema = v.looseObject({
  x402Version: v.literal(2),
  resource: ResourceInfoSchema,
  accepts: v.array(X402PaymentRequirementsEnvelopeSchema),
  error: v.optional(v.string()),
  extensions: v.nullish(PaymentExtensionsSchema),
});

/** True when `x` is a well-formed 402 envelope, whatever schemes it offers. */
export function isX402PaymentRequiredResponse(
  x: unknown,
): x is X402PaymentRequiredResponse<X402PaymentRequirements<unknown>> {
  return v.is(X402PaymentRequiredResponseEnvelopeSchema, x);
}

/** canton-exact 402 response: `accepts[]` of {@link CantonPaymentRequirements}. */
export const CantonPaymentRequiredResponseSchema = v.object({
  x402Version: v.literal(2),
  resource: ResourceInfoSchema,
  accepts: v.array(CantonPaymentRequirementsSchema),
  error: v.optional(v.string()),
  extensions: v.nullish(PaymentExtensionsSchema),
});

export type CantonPaymentRequiredResponse = v.InferOutput<
  typeof CantonPaymentRequiredResponseSchema
>;

export function isCantonPaymentRequiredResponse(x: unknown): x is CantonPaymentRequiredResponse {
  return v.is(CantonPaymentRequiredResponseSchema, x);
}
