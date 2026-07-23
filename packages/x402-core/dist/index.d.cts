/**
 * x402 protocol version — the envelope discriminant. Pinned to `2` today; widen
 * to a union (`2 | 3 | …`) here when a new protocol version lands, and every
 * envelope updates in one place.
 */
type X402Version = 2;
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
type NetworkId = string;
/**
 * Payment scheme identifier. Open union: the literal members are the schemes
 * *this package* defines (today just `exact-canton`), so they autocomplete and a
 * typo is caught; the `(string & {})` tail keeps the envelope extensible, so a
 * scheme defined elsewhere (e.g. the facilitator's `batch-settlement-canton` /
 * `exact-evm-to-canton-cc`) is still assignable. Add a literal here when core
 * itself ships a verifier for that scheme.
 */
type Scheme = "exact-canton" | (string & {});
/** Splice Token Standard instrument identifier. */
interface InstrumentId {
    /** Instrument name. For Canton Coin: "Amulet". */
    id: string;
    /** Admin party ID for the instrument (e.g. DSO::1220...). */
    admin: string;
}
interface AssetSpec {
    instrumentId: InstrumentId;
}
/**
 * A contract disclosed alongside a prepared transaction (Canton Ledger API
 * `DisclosedContract`).
 */
interface DisclosedContract {
    templateId: string;
    contractId: string;
    /** Base64 `createdEventBlob` from the ledger. */
    createdEventBlob: string;
    synchronizerId: string;
}

/**
 * Generic PaymentRequirements — the merchant's 402 offer. The scheme-specific seams
 * are `TAsset` (the asset descriptor) and `TExtra` (the scheme's `extra` bag); every
 * other field is shared. `scheme` is the open {@link Scheme} union so schemes share
 * the envelope.
 */
interface X402PaymentRequirements<TAsset = AssetSpec, TExtra = Record<string, unknown>> {
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
/** exact-canton requirements: a Splice {@link AssetSpec}, sent in the 402's accepts[]. */
type CantonPaymentRequirements = X402PaymentRequirements<AssetSpec>;
/**
 * The `402 Payment Required` response body — returned by the merchant/resource
 * server, listing the payment options the client may satisfy. The client picks
 * one of `accepts[]`, pays it, and retries the request with the `X-PAYMENT`
 * header. Produced by the merchant middleware; parsed by the auto-pay client.
 *
 * Generic over the `accepts[]` element (`TRequirements`) so a mixed-scheme offer
 * (e.g. exact-canton + a bridge scheme) is expressible as a union; every other
 * field is shared. `CantonPaymentRequiredResponse` binds it to the Canton scheme.
 */
interface X402PaymentRequiredResponse<TRequirements = CantonPaymentRequirements> {
    x402Version: X402Version;
    /** Payment options; the client satisfies exactly one of them. */
    accepts: TRequirements[];
    /** Optional machine-readable reason, e.g. "payment_required". */
    error?: string;
}
/** exact-canton 402 response: `accepts[]` of {@link CantonPaymentRequirements}. */
type CantonPaymentRequiredResponse = X402PaymentRequiredResponse<CantonPaymentRequirements>;

/**
 * Canton interactive-submission hashing-scheme versions. These are the protobuf
 * `HashingSchemeVersion` enum names; on the JSON Ledger API they travel as these
 * strings, so we mirror them here as the single source of truth rather than pull
 * in Canton proto codegen. Open union — a future Canton version stays assignable.
 */
declare const HashingSchemeVersion: {
    readonly V2: "HASHING_SCHEME_VERSION_V2";
    readonly V3: "HASHING_SCHEME_VERSION_V3";
};
type HashingSchemeVersion = (typeof HashingSchemeVersion)[keyof typeof HashingSchemeVersion] | (string & {});
/**
 * The inner payload that a wallet packs into the X-PAYMENT header.
 */
interface CantonPaymentInner {
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
/**
 * Generic x402 payment envelope. `TInner` is the scheme-specific inner payload —
 * the whole `payload` object is the one chain-specific seam. `scheme` is the open
 * {@link Scheme} union so schemes share the envelope; each scheme guards on the
 * literal it knows.
 */
interface X402PaymentPayload<TInner = CantonPaymentInner> {
    x402Version: X402Version;
    scheme: Scheme;
    network: NetworkId;
    payload: TInner;
}
/** exact-canton payload: the X-PAYMENT envelope carrying a {@link CantonPaymentInner}. */
type CantonPaymentPayload = X402PaymentPayload<CantonPaymentInner>;

/**
 * Generic request body for POST /v2/verify and /v2/settle — payload + requirements,
 * parameterized by the same scheme seams. The two operations take the identical
 * envelope, so `SettleRequest` aliases `VerifyRequest`.
 */
interface X402Request<TInner = CantonPaymentInner, TAsset = AssetSpec, TExtra = Record<string, unknown>> {
    x402Version: X402Version;
    paymentPayload: X402PaymentPayload<TInner>;
    paymentRequirements: X402PaymentRequirements<TAsset, TExtra>;
}
/** exact-canton verify/settle request. */
type VerifyRequest = X402Request;
type SettleRequest = VerifyRequest;
/**
 * The pure verification contract every scheme implements. Core owns it as the
 * single source of truth; the facilitator and any client conform to it. `verify`
 * is a stateless payload-against-requirements check — the shared shape is
 * identical across schemes, only the proof mechanics differ (exact-canton:
 * Ed25519 over the prepared-tx hash + fingerprint + requirementsHash binding).
 *
 * Stateful concerns — nonce replay, on-chain execution, public-key *resolution*
 * from a party id — are deliberately NOT here; they stay in the facilitator and
 * compose on top of this.
 *
 * The params are the widest envelope (`unknown` inner/asset), so a heterogeneous
 * registry of verifiers type-checks and each verifier narrows via its own guard —
 * adding a scheme is "register a new verifier", with no dispatcher change.
 */
interface SchemeVerifier {
    readonly schemeId: string;
    /** The concrete network this verifier is bound to, e.g. `canton:<synchronizer>`. */
    readonly networkId: NetworkId;
    verify(payload: X402PaymentPayload<unknown>, requirements: X402PaymentRequirements<unknown>): VerifyResponse;
}
type VerifyInvalidReason = "scheme_mismatch" | "network_mismatch" | "requirements_expired" | "requirements_hash_mismatch" | "bad_fingerprint" | "bad_signature" | "nonce_replayed" | "missing_public_key" | "internal_error";
interface VerifyResponseValid {
    isValid: true;
    payer?: string;
    /** Scheme-specific extra fields (mirrors upstream x402 v2 `extensions`). */
    extensions?: Record<string, unknown>;
}
interface VerifyResponseInvalid {
    isValid: false;
    invalidReason: VerifyInvalidReason;
    payer?: string;
    extensions?: Record<string, unknown>;
}
/** Discriminated on `isValid`. */
type VerifyResponse = VerifyResponseValid | VerifyResponseInvalid;
type SettleErrorReason = "bad_request" | "unauthorized" | "scheme_mismatch" | "network_mismatch" | "requirements_expired" | "requirements_hash_mismatch" | "bad_fingerprint" | "bad_signature" | "nonce_replayed" | "execution_failed" | "timeout" | "facilitator_error";
interface SettleResponseSuccess {
    success: true;
    network: NetworkId;
    /** Canton updateId of the executed transaction. */
    transaction: string;
    completionOffset?: string;
    payer: string;
    extensions?: Record<string, unknown>;
}
interface SettleResponseError {
    success: false;
    errorReason: SettleErrorReason;
    errorDetails?: string;
}
/** Discriminated on `success`. */
type SettleResponse = SettleResponseSuccess | SettleResponseError;
interface SupportedKind {
    x402Version: X402Version;
    scheme: Scheme;
    network: NetworkId;
    extra?: Record<string, unknown>;
}
interface SupportedResponse {
    kinds: SupportedKind[];
}

/**
 * Request body for the facilitator's `/payment-object` endpoint. The client asks
 * the facilitator to route the Splice TransferFactory + choice context for a
 * given payer/merchant/asset, which it then feeds into the prepare call.
 */
interface CantonPaymentObjectRequest {
    amount: string;
    merchantParty: string;
    payerParty: string;
    resource: string;
    description?: string;
    /** ISO 8601; when the resulting payment object expires. */
    expiresAt?: string;
    /** Optional x402 payment signature for validation. */
    x402Signature?: string;
    /** Optional webhook URL for async settlement notification. */
    notificationUrl?: string;
    /** Payer's holding contract IDs; the facilitator queries them if omitted. */
    holdingCids?: string[];
    /** Asset to settle in; defaults to Amulet (admin = DSO) when omitted. */
    asset?: AssetSpec;
}
/**
 * The routed TransferFactory + choice context the client feeds into
 * `/v2/interactive-submission/prepare`.
 */
interface CantonPaymentObject {
    amount: string;
    merchantParty: string;
    payerParty: string;
    expiresAt: string;
    resource: string;
    description?: string;
    /** Facilitator fee (decimal string); "0.00" today. */
    facilitatorFee: string;
    /** amount + facilitatorFee. */
    totalAmount: string;
    transferFactory: {
        contractId: string;
        disclosedContracts: DisclosedContract[];
    };
    /** Opaque Splice Token Standard choice context (registry-specific). */
    choiceContext: Record<string, unknown>;
}
interface CantonPaymentObjectResponse {
    paymentObject: CantonPaymentObject;
    paymentId: string;
    status: "ready" | "pending" | "completed";
    notificationUrl?: string;
}

/** Decimal string with up to 10 fractional places (matches `maxAmountRequired`). */
declare function isValidAmount(amount: string): boolean;
/** True iff `validBefore` (ISO 8601) is unparseable or at/before `now` (expired). */
declare function isExpired(validBefore: string, now?: number): boolean;
/** The payload's scheme + network must match the requirements. */
declare function schemeNetworkMatches(payload: X402PaymentPayload<unknown>, requirements: X402PaymentRequirements<unknown>): boolean;
/**
 * True iff a claimed `requirementsHash` (hex) equals the canonical hash of the
 * requirements — the binding that stops a signed payload being replayed against a
 * different (resource, amount, payTo, …). Scheme-agnostic: the canonicalizer walks
 * the requirements structurally.
 */
declare function requirementsHashMatches(requirements: X402PaymentRequirements<unknown>, claimedHashHex: string): boolean;
/**
 * Loose guard for the outer payment envelope: x402 v2, any non-empty scheme (the
 * per-scheme verifier validates the inner `payload` shape), a network, and a
 * `payload` object. Scheme-agnostic — intentionally does NOT assert any scheme's
 * inner fields; use a scheme guard (e.g. `isCantonPaymentInner`) for that.
 */
declare function isX402PaymentPayload(v: unknown): v is X402PaymentPayload<unknown>;

/**
 * Canton key fingerprint for a base64 Ed25519 public key:
 * `1220` + hex(SHA-256(0x0000000c ‖ pubkey)). Must equal the payer party's
 * `::<fingerprint>` suffix. Ported from the facilitator (parity-tested).
 */
declare function fingerprintForPublicKey(publicKeyBase64: string): string;
/** True iff the public key's fingerprint equals the claimed one (case-insensitive). */
declare function matchesFingerprint(publicKeyBase64: string, claimedFingerprint: string): boolean;
/**
 * Verify an Ed25519 signature (hex) over a prepared-transaction hash (hex) with a
 * base64 public key. Length-checks defensively; returns false on any error.
 */
declare function verifySignature(hashHex: string, signatureHex: string, publicKeyBase64: string): boolean;
/**
 * Ed25519-sign a prepared-transaction hash (hex) with a base64 32-byte seed,
 * returning the signature as hex. Counterpart to {@link verifySignature} — the
 * signature it produces is exactly what `verifySignature` (and the facilitator)
 * accept.
 */
declare function signHash(hashHex: string, privateKeyBase64: string): string;
declare function isCantonNetworkId(x: unknown): x is NetworkId;
declare function parseCantonNetworkId(s: string): NetworkId;
declare function isCantonPaymentRequirements(v: unknown): v is CantonPaymentRequirements;
declare function isCantonPaymentInner(v: unknown): v is CantonPaymentInner;
declare function isVerifyRequest(v: unknown): v is VerifyRequest;
/**
 * Build an exact-canton {@link SchemeVerifier} bound to a specific Canton network
 * (`canton:<synchronizer-id>`) — mirroring how the facilitator reads its network
 * from the chain provider. The registry dispatches on `(schemeId, networkId)`.
 */
declare function createExactCantonVerifier(networkId: NetworkId): SchemeVerifier;

interface VerifierRegistry {
    /** The verifier registered for this exact (scheme, network), or undefined. */
    find(scheme: string, network: NetworkId): SchemeVerifier | undefined;
    /** Dispatch a payload to its verifier; `scheme_mismatch` if none is registered. */
    verify(payload: X402PaymentPayload<unknown>, requirements: X402PaymentRequirements<unknown>): VerifyResponse;
}
/**
 * Build a dispatcher over a fixed set of verifiers. Last registration for a given
 * (scheme, network) wins, matching a plain `Map` insertion.
 */
declare function createVerifierRegistry(verifiers: readonly SchemeVerifier[]): VerifierRegistry;

declare const DEVNET_NETWORK: NetworkId;
declare const DEVNET_SYNCHRONIZER_ID = "global-domain::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a";
declare const DEVNET_DSO_PARTY = "DSO::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a";
declare const MAINNET_NETWORK: NetworkId;
declare const MAINNET_SYNCHRONIZER_ID = "global-domain::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";
declare const MAINNET_DSO_PARTY = "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";
/** Amulet (Canton Coin) instrument for a given DSO admin party. */
declare function amuletAsset(dsoParty: string): AssetSpec;

interface DecodedPaymentHeader {
    payload: CantonPaymentPayload;
    /** The requirements the payload was signed against, echoed from the 402. */
    requirements: CantonPaymentRequirements;
}
/**
 * Serialise a payment together with the requirements it was signed against into
 * an `X-PAYMENT` header value. Inverse of {@link decodePaymentHeader}.
 */
declare function encodePaymentHeader(payload: CantonPaymentPayload, requirements: CantonPaymentRequirements): string;
/**
 * Parse an `X-PAYMENT` header value into the payment payload and the requirements
 * it was signed against. Throws on bad base64 / JSON / envelope shape, or when the
 * requirements are missing.
 */
declare function decodePaymentHeader(headerValue: string): DecodedPaymentHeader;

/**
 * requirementsHash — SHA-256 hex of the canonical PaymentRequirements. Binds a
 * signed payload to this exact (resource, amount, payTo, …). The canonicalizer
 * walks the whole object structurally, so it's scheme-agnostic in the asset/extra
 * seams — hence the widened `X402PaymentRequirements<unknown>` parameter.
 */
declare function requirementsHash(requirements: X402PaymentRequirements<unknown>): string;

export { type AssetSpec, type CantonPaymentInner, type CantonPaymentObject, type CantonPaymentObjectRequest, type CantonPaymentObjectResponse, type CantonPaymentPayload, type CantonPaymentRequiredResponse, type CantonPaymentRequirements, DEVNET_DSO_PARTY, DEVNET_NETWORK, DEVNET_SYNCHRONIZER_ID, type DecodedPaymentHeader, type DisclosedContract, HashingSchemeVersion, type InstrumentId, MAINNET_DSO_PARTY, MAINNET_NETWORK, MAINNET_SYNCHRONIZER_ID, type NetworkId, type Scheme, type SchemeVerifier, type SettleErrorReason, type SettleRequest, type SettleResponse, type SettleResponseError, type SettleResponseSuccess, type SupportedKind, type SupportedResponse, type VerifierRegistry, type VerifyInvalidReason, type VerifyRequest, type VerifyResponse, type VerifyResponseInvalid, type VerifyResponseValid, type X402PaymentPayload, type X402PaymentRequiredResponse, type X402PaymentRequirements, type X402Request, type X402Version, amuletAsset, createExactCantonVerifier, createVerifierRegistry, decodePaymentHeader, encodePaymentHeader, fingerprintForPublicKey, isCantonNetworkId, isCantonPaymentInner, isCantonPaymentRequirements, isExpired, isValidAmount, isVerifyRequest, isX402PaymentPayload, matchesFingerprint, parseCantonNetworkId, requirementsHash, requirementsHashMatches, schemeNetworkMatches, signHash, verifySignature };
