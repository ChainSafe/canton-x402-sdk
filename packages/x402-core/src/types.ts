// x402 exact-canton wire types — the request/response shapes exchanged with the
// facilitator. This is the canonical contract shared by the client SDK and the
// facilitator server. Spec: canton-x402 spec §5–§6.
//
// v2 (exact-canton) only; legacy v1 shapes are intentionally not carried over.
//
// FUTURE (multi-scheme generics — not yet applied): the types below are bound to
// the single exact-canton scheme. When a SECOND scheme lands (batch-settlement /
// USDCx), lift a chain-agnostic layer and keep the Canton types as thin aliases:
//
//   interface X402PaymentPayload<TInner> { x402Version; scheme; network; payload: TInner }
//   interface X402PaymentRequirements<TAsset, TExtra> { …; asset: TAsset; extra?: TExtra }
//   interface X402Request<TInner, TAsset, TExtra> { paymentPayload; paymentRequirements }
//   type CantonPaymentPayload      = X402PaymentPayload<CantonPaymentInner>
//   type CantonPaymentRequirements = X402PaymentRequirements<AssetSpec>
// 
// Chain-specific seams: the payload's ENTIRE `payload` object (→ TInner); in
// requirements the ONLY chain-specific field is `asset` (→ TAsset); scheme-specific
// `extra` (→ TExtra). Use defaulted type params so existing call sites don't change.
// Also pending (markers inline): `scheme` open union; reason-union open-vs-closed.
// Factor against the REAL second-scheme shapes, not speculatively.

/**
 * x402 protocol version — the envelope discriminant. Pinned to `2` today; widen
 * to a union (`2 | 3 | …`) here when a new protocol version lands, and every
 * envelope updates in one place.
 */
export type X402Version = 2;

/**
 * Network identifier carried in the (scheme-generic) envelope. Its concrete
 * format is scheme-dependent — `exact-canton` uses `canton:<synchronizer-id>`,
 * other schemes (e.g. an EVM bridge) use their own CAIP-2 id (`eip155:<chainId>`)
 * — so the shared type stays a plain string. The `canton:` shape is validated at
 * runtime by the exact-canton verify path (#5), not enforced here.
 *
 * FUTURE: once the envelope is parameterized per scheme, an exact-canton-specific
 * `CantonNetworkId = `canton:${string}`` can narrow this for that scheme only.
 */
export type NetworkId = string;

// FUTURE: introduce a shared open union so known schemes autocomplete while the
// envelope stays extensible, e.g.
//   export type Scheme = "exact-canton" | "batch-settlement-canton" | (string & {});
// Then use `Scheme` for the `scheme` fields below instead of bare `string`.

/** Splice Token Standard instrument identifier. */
export interface InstrumentId {
  /** Instrument name. For Canton Coin: "Amulet". */
  id: string;
  /** Admin party ID for the instrument (e.g. DSO::1220...). */
  admin: string;
}

export interface AssetSpec {
  instrumentId: InstrumentId;
}

/**
 * A contract disclosed alongside a prepared transaction (Canton Ledger API
 * `DisclosedContract`). Typed explicitly — do not pass registry payloads with
 * extra `debug*` keys straight through; the Ledger API rejects unknown fields.
 */
export interface DisclosedContract {
  templateId: string;
  contractId: string;
  /** Base64 `createdEventBlob` from the ledger. */
  createdEventBlob: string;
  synchronizerId: string;
}

/**
 * PaymentRequirements — sent by the merchant in the 402 response's accepts[].
 */
export interface CantonPaymentRequirements {
  // Widened from the literal `"exact-canton"` so additional schemes can share
  // the envelope. Each scheme guards on the literal it recognises.
  // FUTURE: use the shared `Scheme` open union (above) for autocomplete.
  scheme: string;
  network: NetworkId;
  /** Decimal-string CC amount, up to 10 decimal places. */
  // FUTURE: a branded `DecimalString` type would document the format at the type level.
  maxAmountRequired: string;
  // FUTURE: the ONLY chain-specific field here — becomes the `TAsset` slot (see header).
  asset: AssetSpec;
  /** Recipient Canton party ID. */
  payTo: string;
  /** Resource URL the wallet is paying for. */
  resource: string;
  description?: string;
  /** Unique nonce; UUID v4 recommended. */
  nonce: string;
  /** ISO 8601 timestamp; facilitator rejects /settle after this. */
  validBefore: string;
  maxTimeoutSeconds?: number;
  // FUTURE: scheme-specific shape → the `TExtra` slot (see header); e.g. the
  // bridge's `cantonRecipient` instead of an untyped bag.
  extra?: Record<string, unknown>;
}

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
  // header); other schemes carry their own shape without `as unknown as`.
  payload: CantonPaymentInner;
}

/**
 * Shared request body for POST /v2/verify and /v2/settle. The two operations
 * take the identical envelope, so `SettleRequest` is an alias of `VerifyRequest`.
 */
export interface VerifyRequest {
  x402Version: X402Version;
  // FUTURE: parameterize as `X402Request<TInner, TAsset, TExtra>` (see header).
  paymentPayload: CantonPaymentPayload;
  paymentRequirements: CantonPaymentRequirements;
}

export type SettleRequest = VerifyRequest;

// FUTURE: appending `| (string & {})` to the reason unions below would let a
// newer facilitator return a reason an older client doesn't know without
// breaking deserialization — at the cost of losing exhaustive-switch checking.
// Decide deliberately before doing it.
export type VerifyInvalidReason =
  | "scheme_mismatch"
  | "network_mismatch"
  | "requirements_expired"
  | "requirements_hash_mismatch"
  | "bad_fingerprint"
  | "bad_signature"
  | "nonce_replayed"
  | "missing_public_key"
  | "internal_error";

export interface VerifyResponseValid {
  isValid: true;
  payer?: string;
  /** Scheme-specific extra fields (mirrors upstream x402 v2 `extensions`). */
  extensions?: Record<string, unknown>;
}

export interface VerifyResponseInvalid {
  isValid: false;
  invalidReason: VerifyInvalidReason;
  payer?: string;
  extensions?: Record<string, unknown>;
}

/** Discriminated on `isValid`. */
export type VerifyResponse = VerifyResponseValid | VerifyResponseInvalid;

export type SettleErrorReason =
  | "bad_request"
  | "unauthorized"
  | "scheme_mismatch"
  | "network_mismatch"
  | "requirements_expired"
  | "requirements_hash_mismatch"
  | "bad_fingerprint"
  | "bad_signature"
  | "nonce_replayed"
  | "execution_failed"
  | "timeout"
  | "facilitator_error";

export interface SettleResponseSuccess {
  success: true;
  network: NetworkId;
  /** Canton updateId of the executed transaction. */
  transaction: string;
  completionOffset?: string;
  payer: string;
  extensions?: Record<string, unknown>;
}

export interface SettleResponseError {
  success: false;
  errorReason: SettleErrorReason;
  errorDetails?: string;
}

/** Discriminated on `success`. */
export type SettleResponse = SettleResponseSuccess | SettleResponseError;

export interface SupportedKind {
  x402Version: X402Version;
  scheme: string;
  network: NetworkId;
  extra?: Record<string, unknown>;
}

export interface SupportedResponse {
  kinds: SupportedKind[];
}
