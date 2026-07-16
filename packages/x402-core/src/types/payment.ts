import type { NetworkId, X402Version } from "./common";

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
 * The inner payload that a wallet packs into the X-PAYMENT header.
 */
export interface CantonPaymentInner {
  /** Paying Canton party ID. */
  payer: string;
  /** Base64-encoded opaque blob from /v2/interactive-submission/prepare. */
  preparedTransaction: string;
  /** Hex of the hash that was signed. */
  preparedTransactionHash: string;
  /** Hex Ed25519 signature over preparedTransactionHash. */
  partySignature: string;
  /** SHA-256 of the canonical (RFC-8785) PaymentRequirements. */
  requirementsHash: string;
  /**
   * Base64 32-byte Ed25519 public key. Required — the facilitator verifies the
   * signature against it and derives the party fingerprint from it (the party id's
   * `::<fingerprint>` suffix is a hash of this key).
   */
  publicKey: string;
  /**
   * Canton interactive-submission hashing scheme the payload was prepared with.
   * Required — the signature is bound to a hash computed with this version, so the
   * facilitator's execute must use the same one. Omitting it and relying on a
   * default risks a hash mismatch and a rejected signature.
   */
  hashingSchemeVersion: HashingSchemeVersion;
}

export interface CantonPaymentPayload {
  x402Version: X402Version;
  // Widened (see CantonPaymentRequirements). Different schemes carry different
  // inner-payload shapes; the declared type stays the exact-canton shape.
  scheme: string;
  network: NetworkId;
  // FUTURE: the entire inner object is chain-specific → the `TInner` slot (see
  // index header); other schemes carry their own shape without `as unknown as`.
  payload: CantonPaymentInner;
}
