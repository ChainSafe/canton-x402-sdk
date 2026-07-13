import type { DisclosedContract, NetworkId, X402Version } from "./common";

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
  /** Hex SHA256(0x0000000c || publicKey); MUST equal payer's fingerprint suffix. */
  keyFingerprint: string;
  /** Contract ID of the TransferFactory used during prepare. */
  transferFactoryId: string;
  /** Opaque object returned by Splice Token Standard's transfer-factory API. */
  // FUTURE: type per registry, or make Inner generic over the choice-context shape.
  choiceContext: Record<string, unknown>;
  /** Disclosed contracts required by the prepared transaction. */
  disclosedContracts: DisclosedContract[];
  /** SHA-256 of the canonical (RFC-8785) PaymentRequirements. */
  requirementsHash: string;
  /** OPTIONAL in v0.1; required in v0.2. Base64 32-byte Ed25519 public key. */
  publicKey?: string;
  /**
   * Canton interactive-submission hashing scheme the wallet prepared with.
   * The facilitator's execute MUST use the same version or Canton recomputes a
   * different hash and rejects the signature. Per-request because it's a
   * property of how the buyer prepared, not a facilitator global.
   */
  hashingSchemeVersion?: HashingSchemeVersion;
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
