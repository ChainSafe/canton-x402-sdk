import * as v from "valibot";
import type { NetworkId, Scheme, X402Version } from "./common";

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
 * The inner payload that a wallet packs into the X-PAYMENT header. Schema-first:
 * the guard/parse and the type both derive from this one definition, so the
 * validator can't drift from (or under-check) the type.
 */
export const CantonPaymentInnerSchema = v.object({
  /** Paying Canton party ID. */
  payer: v.string(),
  /** Base64-encoded opaque blob from /v2/interactive-submission/prepare. */
  preparedTransaction: v.string(),
  /** Hex of the hash that was signed. */
  preparedTransactionHash: v.string(),
  /** Hex Ed25519 signature over preparedTransactionHash. */
  partySignature: v.string(),
  /** SHA-256 of the canonical (RFC-8785) PaymentRequirements. */
  requirementsHash: v.string(),
  /**
   * Base64 32-byte Ed25519 public key. Required — the facilitator verifies the
   * signature against it and derives the party fingerprint from it (the party id's
   * `::<fingerprint>` suffix is a hash of this key).
   */
  publicKey: v.string(),
  /**
   * Canton interactive-submission hashing scheme the payload was prepared with.
   * Required — the signature is bound to a hash computed with this version, so the
   * facilitator's execute must use the same one. Validated as a string (the
   * {@link HashingSchemeVersion} open union is a type-level nicety).
   */
  hashingSchemeVersion: v.string(),
});
export type CantonPaymentInner = v.InferOutput<typeof CantonPaymentInnerSchema>;

/**
 * Generic x402 payment envelope. `TInner` is the scheme-specific inner payload —
 * the whole `payload` object is the one chain-specific seam. `scheme` is the open
 * {@link Scheme} union so schemes share the envelope; each scheme guards on the
 * literal it knows. Generic → type-only (valibot can't infer a generic); the
 * loose runtime envelope check lives in `isX402PaymentPayload`.
 */
export interface X402PaymentPayload<TInner = CantonPaymentInner> {
  x402Version: X402Version;
  scheme: Scheme;
  network: NetworkId;
  payload: TInner;
}

/** exact-canton payload: the X-PAYMENT envelope carrying a {@link CantonPaymentInner}. */
export const CantonPaymentPayloadSchema = v.object({
  x402Version: v.literal(2),
  scheme: v.string(),
  network: v.string(),
  payload: CantonPaymentInnerSchema,
});
export type CantonPaymentPayload = v.InferOutput<typeof CantonPaymentPayloadSchema>;

/**
 * Loose validator for the outer payment envelope: x402 v2, any non-empty scheme
 * (the per-scheme verifier validates the inner `payload`), a network, and a
 * `payload` object. `looseObject` so extra envelope keys (e.g. the echoed
 * `paymentRequirements` the X-PAYMENT header carries) pass through. Scheme-agnostic
 * — use {@link isCantonPaymentInner} for the exact-canton inner.
 */
export const X402PaymentEnvelopeSchema = v.looseObject({
  x402Version: v.literal(2),
  scheme: v.pipe(v.string(), v.minLength(1)),
  network: v.string(),
  payload: v.looseObject({}),
});

export function isX402PaymentPayload(x: unknown): x is X402PaymentPayload<unknown> {
  return v.is(X402PaymentEnvelopeSchema, x);
}

/** exact-canton inner-payload guard + parser (schema-derived). */
export function isCantonPaymentInner(x: unknown): x is CantonPaymentInner {
  return v.is(CantonPaymentInnerSchema, x);
}
export function parseCantonPaymentInner(input: unknown): CantonPaymentInner {
  return v.parse(CantonPaymentInnerSchema, input);
}

/** exact-canton payload guard + parser — the full envelope incl. the inner (schema-derived). */
export function isCantonPaymentPayload(x: unknown): x is CantonPaymentPayload {
  return v.is(CantonPaymentPayloadSchema, x);
}
export function parseCantonPaymentPayload(input: unknown): CantonPaymentPayload {
  return v.parse(CantonPaymentPayloadSchema, input);
}
