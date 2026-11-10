import * as v from "valibot";
import { ASSET_TRANSFER_METHOD, PaymentExtensionsSchema, ResourceInfoSchema } from "./common";
import type { PaymentExtensions, ResourceInfo, X402Version } from "./common";
import { X402PaymentRequirementsEnvelopeSchema } from "./requirements";
import type { X402PaymentRequirements } from "./requirements";

/**
 * Canton interactive-submission hashing-scheme versions. These are the protobuf
 * `HashingSchemeVersion` enum names; on the JSON Ledger API they travel as these
 * strings, so we mirror them here as the single source of truth rather than pull
 * in Canton proto codegen. Open union — a future Canton version stays assignable.
 */
export const HashingSchemeVersion = {
  V2: "HASHING_SCHEME_VERSION_V2",
  V3: "HASHING_SCHEME_VERSION_V3",
} as const;
export type HashingSchemeVersion =
  | (typeof HashingSchemeVersion)[keyof typeof HashingSchemeVersion]
  | (string & {});

/**
 * The inner payload that a wallet packs into the `PAYMENT-SIGNATURE` header. Schema-first:
 * the guard/parse and the type both derive from this one definition, so the
 * validator can't drift from (or under-check) the type.
 */
export const CantonPaymentInnerSchema = v.object({
  /**
   * MUST be `transfer-factory`, the same literal as the requirements'
   * `extra.assetTransferMethod`: the spec requires it in both places. Any other
   * value fails the shape check.
   */
  assetTransferMethod: v.literal(ASSET_TRANSFER_METHOD),
  /**
   * The prepared transaction from /v2/interactive-submission/prepare, as base64
   * of exactly one gzip member ({@link gzipPreparedTransaction}): at most 8 KiB
   * compressed and 64 KiB decompressed.
   */
  preparedTransaction: v.string(),
  /**
   * The hash the payer signed: 32 bytes as lower-case hex, no multihash prefix.
   * Non-empty here; the verifier checks the encoding itself.
   */
  preparedTxHash: v.pipe(v.string(), v.minLength(1)),
  /**
   * The payer's Ed25519 signature over `preparedTxHash`: 64 bytes as canonical
   * standard base64. Base64, not hex — the spec's encoding, and the one the
   * ledger's `partySignatures` takes, so the facilitator relays it unchanged.
   * Non-empty here; the verifier checks the encoding itself. Nothing here names
   * the payer: it is the signed transfer's sender (spec Rule 8).
   */
  signature: v.pipe(v.string(), v.minLength(1)),
  /**
   * Base64 32-byte Ed25519 public key. Required — the facilitator verifies the
   * signature against it, and its fingerprint must match the transfer sender's
   * `::<fingerprint>` suffix. The spec's payload has no such field: it stays
   * until the facilitator can read the sender party's keys from the ledger.
   */
  publicKey: v.string(),
  /**
   * Canton interactive-submission hashing scheme the payload was prepared with.
   * The signature is bound to a hash computed with this version, so the
   * facilitator's execute must use the same one. Optional: the spec reads an
   * absent value as {@link HashingSchemeVersion.V2}. Validated as a string (the
   * {@link HashingSchemeVersion} open union is a type-level nicety).
   */
  hashingSchemeVersion: v.optional(v.string()),
});
export type CantonPaymentInner = v.InferOutput<typeof CantonPaymentInnerSchema>;

/**
 * Generic x402 v2 payment envelope. `TInner` is the scheme-specific inner payload —
 * the whole `payload` object is the one chain-specific seam — and `TExtra` is
 * `accepted`'s `extra`, as in {@link X402PaymentRequirements}. The scheme and the
 * network are not top-level: they are `accepted`'s, the requirements the payer
 * chose. Generic → type-only (valibot can't infer a generic); the loose runtime
 * envelope check lives in `isX402PaymentPayload`.
 */
export interface X402PaymentPayload<TInner = CantonPaymentInner, TExtra = Record<string, unknown>> {
  x402Version: X402Version;
  /**
   * The `accepts[]` entry the payer chose: a whole `PaymentRequirements`, as the
   * spec defines it. Checked for the fields every scheme's requirements share; a
   * caller that reads `extra` narrows it first.
   */
  accepted: X402PaymentRequirements<TExtra>;
  payload: TInner;
  resource?: ResourceInfo | null;
  extensions?: PaymentExtensions | null;
}

/** canton-exact payload: the payment envelope carrying a {@link CantonPaymentInner}. */
export const CantonPaymentPayloadSchema = v.object({
  x402Version: v.literal(2),
  accepted: X402PaymentRequirementsEnvelopeSchema,
  payload: CantonPaymentInnerSchema,
  resource: v.nullish(ResourceInfoSchema),
  extensions: v.nullish(PaymentExtensionsSchema),
});
export type CantonPaymentPayload = v.InferOutput<typeof CantonPaymentPayloadSchema>;

/**
 * Loose validator for the outer payment envelope: x402 v2, an `accepted` that is
 * a PaymentRequirements ({@link X402PaymentRequirementsEnvelopeSchema}), and a
 * `payload` object (the per-scheme verifier validates the inner). `looseObject` so extra envelope keys pass through.
 * Scheme-agnostic — use {@link isCantonPaymentInner} for the canton-exact inner.
 */
export const X402PaymentEnvelopeSchema = v.looseObject({
  x402Version: v.literal(2),
  accepted: X402PaymentRequirementsEnvelopeSchema,
  payload: v.looseObject({}),
  resource: v.nullish(ResourceInfoSchema),
  extensions: v.nullish(PaymentExtensionsSchema),
});

export function isX402PaymentPayload(x: unknown): x is X402PaymentPayload<unknown, unknown> {
  return v.is(X402PaymentEnvelopeSchema, x);
}

/** canton-exact inner-payload guard + parser (schema-derived). */
export function isCantonPaymentInner(x: unknown): x is CantonPaymentInner {
  return v.is(CantonPaymentInnerSchema, x);
}
export function parseCantonPaymentInner(input: unknown): CantonPaymentInner {
  return v.parse(CantonPaymentInnerSchema, input);
}

/** canton-exact payload guard + parser — the full envelope incl. the inner (schema-derived). */
export function isCantonPaymentPayload(x: unknown): x is CantonPaymentPayload {
  return v.is(CantonPaymentPayloadSchema, x);
}
export function parseCantonPaymentPayload(input: unknown): CantonPaymentPayload {
  return v.parse(CantonPaymentPayloadSchema, input);
}
