import * as v from 'valibot';

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
declare const InstrumentIdSchema: v.ObjectSchema<{
    /** Instrument name. For Canton Coin: "Amulet". */
    readonly id: v.StringSchema<undefined>;
    /** Admin party ID for the instrument (e.g. DSO::1220...). */
    readonly admin: v.StringSchema<undefined>;
}, undefined>;
type InstrumentId = v.InferOutput<typeof InstrumentIdSchema>;
declare const AssetSpecSchema: v.ObjectSchema<{
    readonly instrumentId: v.ObjectSchema<{
        /** Instrument name. For Canton Coin: "Amulet". */
        readonly id: v.StringSchema<undefined>;
        /** Admin party ID for the instrument (e.g. DSO::1220...). */
        readonly admin: v.StringSchema<undefined>;
    }, undefined>;
}, undefined>;
type AssetSpec = v.InferOutput<typeof AssetSpecSchema>;
/**
 * A contract disclosed alongside a prepared transaction (Canton Ledger API
 * `DisclosedContract`).
 */
declare const DisclosedContractSchema: v.ObjectSchema<{
    readonly templateId: v.StringSchema<undefined>;
    readonly contractId: v.StringSchema<undefined>;
    /** Base64 `createdEventBlob` from the ledger. */
    readonly createdEventBlob: v.StringSchema<undefined>;
    readonly synchronizerId: v.StringSchema<undefined>;
}, undefined>;
type DisclosedContract = v.InferOutput<typeof DisclosedContractSchema>;

/**
 * Generic PaymentRequirements — the merchant's 402 offer. The scheme-specific seams
 * are `TAsset` (the asset descriptor) and `TExtra` (the scheme's `extra` bag); every
 * other field is shared. `scheme` is the open {@link Scheme} union so schemes share
 * the envelope. Generic → type-only (the concrete Canton shape below is schema-first).
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
/**
 * exact-canton requirements: a Splice {@link AssetSpec}, sent in the 402's accepts[].
 * Schema-first — the concrete shape, its validator, and its type are one definition.
 */
declare const CantonPaymentRequirementsSchema: v.ObjectSchema<{
    readonly scheme: v.StringSchema<undefined>;
    readonly network: v.StringSchema<undefined>;
    readonly maxAmountRequired: v.StringSchema<undefined>;
    readonly asset: v.ObjectSchema<{
        readonly instrumentId: v.ObjectSchema<{
            readonly id: v.StringSchema<undefined>;
            readonly admin: v.StringSchema<undefined>;
        }, undefined>;
    }, undefined>;
    readonly payTo: v.StringSchema<undefined>;
    readonly resource: v.StringSchema<undefined>;
    readonly description: v.OptionalSchema<v.StringSchema<undefined>, undefined>;
    readonly nonce: v.StringSchema<undefined>;
    readonly validBefore: v.StringSchema<undefined>;
    readonly maxTimeoutSeconds: v.OptionalSchema<v.NumberSchema<undefined>, undefined>;
    readonly extra: v.OptionalSchema<v.RecordSchema<v.StringSchema<undefined>, v.UnknownSchema, undefined>, undefined>;
}, undefined>;
type CantonPaymentRequirements = v.InferOutput<typeof CantonPaymentRequirementsSchema>;
/** exact-canton requirements guard + parser (schema-derived). */
declare function isCantonPaymentRequirements(x: unknown): x is CantonPaymentRequirements;
declare function parseCantonPaymentRequirements(input: unknown): CantonPaymentRequirements;
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
interface X402PaymentRequiredResponse<TRequirements = CantonPaymentRequirements> {
    x402Version: X402Version;
    /** Payment options; the client satisfies exactly one of them. */
    accepts: TRequirements[];
    /** Optional machine-readable reason, e.g. "payment_required". */
    error?: string;
}
/** exact-canton 402 response: `accepts[]` of {@link CantonPaymentRequirements}. */
declare const CantonPaymentRequiredResponseSchema: v.ObjectSchema<{
    readonly x402Version: v.LiteralSchema<2, undefined>;
    readonly accepts: v.ArraySchema<v.ObjectSchema<{
        readonly scheme: v.StringSchema<undefined>;
        readonly network: v.StringSchema<undefined>;
        readonly maxAmountRequired: v.StringSchema<undefined>;
        readonly asset: v.ObjectSchema<{
            readonly instrumentId: v.ObjectSchema<{
                readonly id: v.StringSchema<undefined>;
                readonly admin: v.StringSchema<undefined>;
            }, undefined>;
        }, undefined>;
        readonly payTo: v.StringSchema<undefined>;
        readonly resource: v.StringSchema<undefined>;
        readonly description: v.OptionalSchema<v.StringSchema<undefined>, undefined>;
        readonly nonce: v.StringSchema<undefined>;
        readonly validBefore: v.StringSchema<undefined>;
        readonly maxTimeoutSeconds: v.OptionalSchema<v.NumberSchema<undefined>, undefined>;
        readonly extra: v.OptionalSchema<v.RecordSchema<v.StringSchema<undefined>, v.UnknownSchema, undefined>, undefined>;
    }, undefined>, undefined>;
    readonly error: v.OptionalSchema<v.StringSchema<undefined>, undefined>;
}, undefined>;
type CantonPaymentRequiredResponse = v.InferOutput<typeof CantonPaymentRequiredResponseSchema>;

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
 * The inner payload that a wallet packs into the X-PAYMENT header. Schema-first:
 * the guard/parse and the type both derive from this one definition, so the
 * validator can't drift from (or under-check) the type.
 */
declare const CantonPaymentInnerSchema: v.ObjectSchema<{
    /** Paying Canton party ID. */
    readonly payer: v.StringSchema<undefined>;
    /** Base64-encoded opaque blob from /v2/interactive-submission/prepare. */
    readonly preparedTransaction: v.StringSchema<undefined>;
    /** Hex of the hash that was signed. */
    readonly preparedTransactionHash: v.StringSchema<undefined>;
    /** Hex Ed25519 signature over preparedTransactionHash. */
    readonly partySignature: v.StringSchema<undefined>;
    /** SHA-256 of the canonical (RFC-8785) PaymentRequirements. */
    readonly requirementsHash: v.StringSchema<undefined>;
    /**
     * Base64 32-byte Ed25519 public key. Required — the facilitator verifies the
     * signature against it and derives the party fingerprint from it (the party id's
     * `::<fingerprint>` suffix is a hash of this key).
     */
    readonly publicKey: v.StringSchema<undefined>;
    /**
     * Canton interactive-submission hashing scheme the payload was prepared with.
     * Required — the signature is bound to a hash computed with this version, so the
     * facilitator's execute must use the same one. Validated as a string (the
     * {@link HashingSchemeVersion} open union is a type-level nicety).
     */
    readonly hashingSchemeVersion: v.StringSchema<undefined>;
}, undefined>;
type CantonPaymentInner = v.InferOutput<typeof CantonPaymentInnerSchema>;
/**
 * Generic x402 payment envelope. `TInner` is the scheme-specific inner payload —
 * the whole `payload` object is the one chain-specific seam. `scheme` is the open
 * {@link Scheme} union so schemes share the envelope; each scheme guards on the
 * literal it knows. Generic → type-only (valibot can't infer a generic); the
 * loose runtime envelope check lives in `isX402PaymentPayload`.
 */
interface X402PaymentPayload<TInner = CantonPaymentInner> {
    x402Version: X402Version;
    scheme: Scheme;
    network: NetworkId;
    payload: TInner;
}
/** exact-canton payload: the X-PAYMENT envelope carrying a {@link CantonPaymentInner}. */
declare const CantonPaymentPayloadSchema: v.ObjectSchema<{
    readonly x402Version: v.LiteralSchema<2, undefined>;
    readonly scheme: v.StringSchema<undefined>;
    readonly network: v.StringSchema<undefined>;
    readonly payload: v.ObjectSchema<{
        /** Paying Canton party ID. */
        readonly payer: v.StringSchema<undefined>;
        /** Base64-encoded opaque blob from /v2/interactive-submission/prepare. */
        readonly preparedTransaction: v.StringSchema<undefined>;
        /** Hex of the hash that was signed. */
        readonly preparedTransactionHash: v.StringSchema<undefined>;
        /** Hex Ed25519 signature over preparedTransactionHash. */
        readonly partySignature: v.StringSchema<undefined>;
        /** SHA-256 of the canonical (RFC-8785) PaymentRequirements. */
        readonly requirementsHash: v.StringSchema<undefined>;
        /**
         * Base64 32-byte Ed25519 public key. Required — the facilitator verifies the
         * signature against it and derives the party fingerprint from it (the party id's
         * `::<fingerprint>` suffix is a hash of this key).
         */
        readonly publicKey: v.StringSchema<undefined>;
        /**
         * Canton interactive-submission hashing scheme the payload was prepared with.
         * Required — the signature is bound to a hash computed with this version, so the
         * facilitator's execute must use the same one. Validated as a string (the
         * {@link HashingSchemeVersion} open union is a type-level nicety).
         */
        readonly hashingSchemeVersion: v.StringSchema<undefined>;
    }, undefined>;
}, undefined>;
type CantonPaymentPayload = v.InferOutput<typeof CantonPaymentPayloadSchema>;
/**
 * Loose validator for the outer payment envelope: x402 v2, any non-empty scheme
 * (the per-scheme verifier validates the inner `payload`), a network, and a
 * `payload` object. `looseObject` so extra envelope keys (e.g. the echoed
 * `paymentRequirements` the X-PAYMENT header carries) pass through. Scheme-agnostic
 * — use {@link isCantonPaymentInner} for the exact-canton inner.
 */
declare const X402PaymentEnvelopeSchema: v.LooseObjectSchema<{
    readonly x402Version: v.LiteralSchema<2, undefined>;
    readonly scheme: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    readonly network: v.StringSchema<undefined>;
    readonly payload: v.LooseObjectSchema<{}, undefined>;
}, undefined>;
declare function isX402PaymentPayload(x: unknown): x is X402PaymentPayload<unknown>;
/** exact-canton inner-payload guard + parser (schema-derived). */
declare function isCantonPaymentInner(x: unknown): x is CantonPaymentInner;
declare function parseCantonPaymentInner(input: unknown): CantonPaymentInner;

/**
 * Generic request body for POST /v2/verify and /v2/settle — payload + requirements,
 * parameterized by the same scheme seams. Generic → type-only; the concrete
 * exact-canton request below is schema-first.
 */
interface X402Request<TInner = CantonPaymentInner, TAsset = AssetSpec, TExtra = Record<string, unknown>> {
    x402Version: X402Version;
    paymentPayload: X402PaymentPayload<TInner>;
    paymentRequirements: X402PaymentRequirements<TAsset, TExtra>;
}
/** exact-canton verify/settle request. Settle takes the identical envelope. */
declare const VerifyRequestSchema: v.ObjectSchema<{
    readonly x402Version: v.LiteralSchema<2, undefined>;
    readonly paymentPayload: v.ObjectSchema<{
        readonly x402Version: v.LiteralSchema<2, undefined>;
        readonly scheme: v.StringSchema<undefined>;
        readonly network: v.StringSchema<undefined>;
        readonly payload: v.ObjectSchema<{
            readonly payer: v.StringSchema<undefined>;
            readonly preparedTransaction: v.StringSchema<undefined>;
            readonly preparedTransactionHash: v.StringSchema<undefined>;
            readonly partySignature: v.StringSchema<undefined>;
            readonly requirementsHash: v.StringSchema<undefined>;
            readonly publicKey: v.StringSchema<undefined>;
            readonly hashingSchemeVersion: v.StringSchema<undefined>;
        }, undefined>;
    }, undefined>;
    readonly paymentRequirements: v.ObjectSchema<{
        readonly scheme: v.StringSchema<undefined>;
        readonly network: v.StringSchema<undefined>;
        readonly maxAmountRequired: v.StringSchema<undefined>;
        readonly asset: v.ObjectSchema<{
            readonly instrumentId: v.ObjectSchema<{
                readonly id: v.StringSchema<undefined>;
                readonly admin: v.StringSchema<undefined>;
            }, undefined>;
        }, undefined>;
        readonly payTo: v.StringSchema<undefined>;
        readonly resource: v.StringSchema<undefined>;
        readonly description: v.OptionalSchema<v.StringSchema<undefined>, undefined>;
        readonly nonce: v.StringSchema<undefined>;
        readonly validBefore: v.StringSchema<undefined>;
        readonly maxTimeoutSeconds: v.OptionalSchema<v.NumberSchema<undefined>, undefined>;
        readonly extra: v.OptionalSchema<v.RecordSchema<v.StringSchema<undefined>, v.UnknownSchema, undefined>, undefined>;
    }, undefined>;
}, undefined>;
type VerifyRequest = v.InferOutput<typeof VerifyRequestSchema>;
type SettleRequest = VerifyRequest;
/** exact-canton verify/settle request guard + parser (schema-derived, concrete). */
declare function isCantonVerifyRequest(x: unknown): x is VerifyRequest;
declare function parseCantonVerifyRequest(input: unknown): VerifyRequest;
declare function isX402Request(x: unknown): x is X402Request<unknown>;
declare function parseX402Request(input: unknown): X402Request<unknown>;
/**
 * The pure verification contract every scheme implements. Core owns it as the
 * single source of truth; the facilitator and any client conform to it. Method
 * interface → type-only.
 *
 * The params are the widest envelope (`unknown` inner/asset), so a heterogeneous
 * registry of verifiers type-checks and each verifier narrows via its own guard.
 */
interface SchemeVerifier {
    readonly schemeId: string;
    /** The concrete network this verifier is bound to, e.g. `canton:<synchronizer>`. */
    readonly networkId: NetworkId;
    verify(payload: X402PaymentPayload<unknown>, requirements: X402PaymentRequirements<unknown>): VerifyResponse;
}
declare const VerifyInvalidReasonSchema: v.PicklistSchema<["scheme_mismatch", "network_mismatch", "requirements_expired", "requirements_hash_mismatch", "bad_fingerprint", "bad_signature", "nonce_replayed", "missing_public_key", "transfer_mismatch", "internal_error"], undefined>;
type VerifyInvalidReason = v.InferOutput<typeof VerifyInvalidReasonSchema>;
declare const VerifyResponseValidSchema: v.ObjectSchema<{
    readonly isValid: v.LiteralSchema<true, undefined>;
    readonly payer: v.OptionalSchema<v.StringSchema<undefined>, undefined>;
    readonly extensions: v.OptionalSchema<v.RecordSchema<v.StringSchema<undefined>, v.UnknownSchema, undefined>, undefined>;
}, undefined>;
type VerifyResponseValid = v.InferOutput<typeof VerifyResponseValidSchema>;
declare const VerifyResponseInvalidSchema: v.ObjectSchema<{
    readonly isValid: v.LiteralSchema<false, undefined>;
    readonly invalidReason: v.PicklistSchema<["scheme_mismatch", "network_mismatch", "requirements_expired", "requirements_hash_mismatch", "bad_fingerprint", "bad_signature", "nonce_replayed", "missing_public_key", "transfer_mismatch", "internal_error"], undefined>;
    readonly payer: v.OptionalSchema<v.StringSchema<undefined>, undefined>;
    readonly extensions: v.OptionalSchema<v.RecordSchema<v.StringSchema<undefined>, v.UnknownSchema, undefined>, undefined>;
}, undefined>;
type VerifyResponseInvalid = v.InferOutput<typeof VerifyResponseInvalidSchema>;
/** Discriminated on `isValid`. */
declare const VerifyResponseSchema: v.VariantSchema<"isValid", [v.ObjectSchema<{
    readonly isValid: v.LiteralSchema<true, undefined>;
    readonly payer: v.OptionalSchema<v.StringSchema<undefined>, undefined>;
    readonly extensions: v.OptionalSchema<v.RecordSchema<v.StringSchema<undefined>, v.UnknownSchema, undefined>, undefined>;
}, undefined>, v.ObjectSchema<{
    readonly isValid: v.LiteralSchema<false, undefined>;
    readonly invalidReason: v.PicklistSchema<["scheme_mismatch", "network_mismatch", "requirements_expired", "requirements_hash_mismatch", "bad_fingerprint", "bad_signature", "nonce_replayed", "missing_public_key", "transfer_mismatch", "internal_error"], undefined>;
    readonly payer: v.OptionalSchema<v.StringSchema<undefined>, undefined>;
    readonly extensions: v.OptionalSchema<v.RecordSchema<v.StringSchema<undefined>, v.UnknownSchema, undefined>, undefined>;
}, undefined>], undefined>;
type VerifyResponse = v.InferOutput<typeof VerifyResponseSchema>;
declare const SettleErrorReasonSchema: v.PicklistSchema<["bad_request", "unauthorized", "scheme_mismatch", "network_mismatch", "requirements_expired", "requirements_hash_mismatch", "bad_fingerprint", "bad_signature", "nonce_replayed", "execution_failed", "timeout", "facilitator_error"], undefined>;
type SettleErrorReason = v.InferOutput<typeof SettleErrorReasonSchema>;
declare const SettleResponseSuccessSchema: v.ObjectSchema<{
    readonly success: v.LiteralSchema<true, undefined>;
    readonly network: v.StringSchema<undefined>;
    /** Canton updateId of the executed transaction. */
    readonly transaction: v.StringSchema<undefined>;
    readonly completionOffset: v.OptionalSchema<v.StringSchema<undefined>, undefined>;
    readonly payer: v.StringSchema<undefined>;
    readonly extensions: v.OptionalSchema<v.RecordSchema<v.StringSchema<undefined>, v.UnknownSchema, undefined>, undefined>;
}, undefined>;
type SettleResponseSuccess = v.InferOutput<typeof SettleResponseSuccessSchema>;
declare const SettleResponseErrorSchema: v.ObjectSchema<{
    readonly success: v.LiteralSchema<false, undefined>;
    readonly errorReason: v.PicklistSchema<["bad_request", "unauthorized", "scheme_mismatch", "network_mismatch", "requirements_expired", "requirements_hash_mismatch", "bad_fingerprint", "bad_signature", "nonce_replayed", "execution_failed", "timeout", "facilitator_error"], undefined>;
    readonly errorDetails: v.OptionalSchema<v.StringSchema<undefined>, undefined>;
}, undefined>;
type SettleResponseError = v.InferOutput<typeof SettleResponseErrorSchema>;
/** Discriminated on `success`. */
declare const SettleResponseSchema: v.VariantSchema<"success", [v.ObjectSchema<{
    readonly success: v.LiteralSchema<true, undefined>;
    readonly network: v.StringSchema<undefined>;
    /** Canton updateId of the executed transaction. */
    readonly transaction: v.StringSchema<undefined>;
    readonly completionOffset: v.OptionalSchema<v.StringSchema<undefined>, undefined>;
    readonly payer: v.StringSchema<undefined>;
    readonly extensions: v.OptionalSchema<v.RecordSchema<v.StringSchema<undefined>, v.UnknownSchema, undefined>, undefined>;
}, undefined>, v.ObjectSchema<{
    readonly success: v.LiteralSchema<false, undefined>;
    readonly errorReason: v.PicklistSchema<["bad_request", "unauthorized", "scheme_mismatch", "network_mismatch", "requirements_expired", "requirements_hash_mismatch", "bad_fingerprint", "bad_signature", "nonce_replayed", "execution_failed", "timeout", "facilitator_error"], undefined>;
    readonly errorDetails: v.OptionalSchema<v.StringSchema<undefined>, undefined>;
}, undefined>], undefined>;
type SettleResponse = v.InferOutput<typeof SettleResponseSchema>;
declare const SupportedKindSchema: v.ObjectSchema<{
    readonly x402Version: v.LiteralSchema<2, undefined>;
    readonly scheme: v.StringSchema<undefined>;
    readonly network: v.StringSchema<undefined>;
    readonly extra: v.OptionalSchema<v.RecordSchema<v.StringSchema<undefined>, v.UnknownSchema, undefined>, undefined>;
}, undefined>;
type SupportedKind = v.InferOutput<typeof SupportedKindSchema>;
declare const SupportedResponseSchema: v.ObjectSchema<{
    readonly kinds: v.ArraySchema<v.ObjectSchema<{
        readonly x402Version: v.LiteralSchema<2, undefined>;
        readonly scheme: v.StringSchema<undefined>;
        readonly network: v.StringSchema<undefined>;
        readonly extra: v.OptionalSchema<v.RecordSchema<v.StringSchema<undefined>, v.UnknownSchema, undefined>, undefined>;
    }, undefined>, undefined>;
}, undefined>;
type SupportedResponse = v.InferOutput<typeof SupportedResponseSchema>;

/**
 * Request body for the facilitator's `/payment-object` endpoint. The client asks
 * the facilitator to route the Splice TransferFactory + choice context for a
 * given payer/merchant/asset, which it then feeds into the prepare call.
 */
declare const CantonPaymentObjectRequestSchema: v.ObjectSchema<{
    readonly amount: v.StringSchema<undefined>;
    readonly merchantParty: v.StringSchema<undefined>;
    readonly payerParty: v.StringSchema<undefined>;
    readonly resource: v.StringSchema<undefined>;
    readonly description: v.OptionalSchema<v.StringSchema<undefined>, undefined>;
    /** ISO 8601; when the resulting payment object expires. */
    readonly expiresAt: v.OptionalSchema<v.StringSchema<undefined>, undefined>;
    /** Optional x402 payment signature for validation. */
    readonly x402Signature: v.OptionalSchema<v.StringSchema<undefined>, undefined>;
    /** Optional webhook URL for async settlement notification. */
    readonly notificationUrl: v.OptionalSchema<v.StringSchema<undefined>, undefined>;
    /** Payer's holding contract IDs; the facilitator queries them if omitted. */
    readonly holdingCids: v.OptionalSchema<v.ArraySchema<v.StringSchema<undefined>, undefined>, undefined>;
    /** Asset to settle in; defaults to Amulet (admin = DSO) when omitted. */
    readonly asset: v.OptionalSchema<v.ObjectSchema<{
        readonly instrumentId: v.ObjectSchema<{
            readonly id: v.StringSchema<undefined>;
            readonly admin: v.StringSchema<undefined>;
        }, undefined>;
    }, undefined>, undefined>;
}, undefined>;
type CantonPaymentObjectRequest = v.InferOutput<typeof CantonPaymentObjectRequestSchema>;
/**
 * The routed TransferFactory + choice context the client feeds into
 * `/v2/interactive-submission/prepare`.
 */
declare const CantonPaymentObjectSchema: v.ObjectSchema<{
    readonly amount: v.StringSchema<undefined>;
    readonly merchantParty: v.StringSchema<undefined>;
    readonly payerParty: v.StringSchema<undefined>;
    readonly expiresAt: v.StringSchema<undefined>;
    readonly resource: v.StringSchema<undefined>;
    readonly description: v.OptionalSchema<v.StringSchema<undefined>, undefined>;
    /** Facilitator fee (decimal string); "0.00" today. */
    readonly facilitatorFee: v.StringSchema<undefined>;
    /** amount + facilitatorFee. */
    readonly totalAmount: v.StringSchema<undefined>;
    readonly transferFactory: v.ObjectSchema<{
        readonly contractId: v.StringSchema<undefined>;
        readonly disclosedContracts: v.ArraySchema<v.ObjectSchema<{
            readonly templateId: v.StringSchema<undefined>;
            readonly contractId: v.StringSchema<undefined>;
            readonly createdEventBlob: v.StringSchema<undefined>;
            readonly synchronizerId: v.StringSchema<undefined>;
        }, undefined>, undefined>;
    }, undefined>;
    /** Opaque Splice Token Standard choice context (registry-specific). */
    readonly choiceContext: v.RecordSchema<v.StringSchema<undefined>, v.UnknownSchema, undefined>;
}, undefined>;
type CantonPaymentObject = v.InferOutput<typeof CantonPaymentObjectSchema>;
declare const CantonPaymentObjectResponseSchema: v.ObjectSchema<{
    readonly paymentObject: v.ObjectSchema<{
        readonly amount: v.StringSchema<undefined>;
        readonly merchantParty: v.StringSchema<undefined>;
        readonly payerParty: v.StringSchema<undefined>;
        readonly expiresAt: v.StringSchema<undefined>;
        readonly resource: v.StringSchema<undefined>;
        readonly description: v.OptionalSchema<v.StringSchema<undefined>, undefined>;
        /** Facilitator fee (decimal string); "0.00" today. */
        readonly facilitatorFee: v.StringSchema<undefined>;
        /** amount + facilitatorFee. */
        readonly totalAmount: v.StringSchema<undefined>;
        readonly transferFactory: v.ObjectSchema<{
            readonly contractId: v.StringSchema<undefined>;
            readonly disclosedContracts: v.ArraySchema<v.ObjectSchema<{
                readonly templateId: v.StringSchema<undefined>;
                readonly contractId: v.StringSchema<undefined>;
                readonly createdEventBlob: v.StringSchema<undefined>;
                readonly synchronizerId: v.StringSchema<undefined>;
            }, undefined>, undefined>;
        }, undefined>;
        /** Opaque Splice Token Standard choice context (registry-specific). */
        readonly choiceContext: v.RecordSchema<v.StringSchema<undefined>, v.UnknownSchema, undefined>;
    }, undefined>;
    readonly paymentId: v.StringSchema<undefined>;
    readonly status: v.PicklistSchema<["ready", "pending", "completed"], undefined>;
    readonly notificationUrl: v.OptionalSchema<v.StringSchema<undefined>, undefined>;
}, undefined>;
type CantonPaymentObjectResponse = v.InferOutput<typeof CantonPaymentObjectResponseSchema>;

/** Decimal string with up to 10 fractional places (matches `maxAmountRequired`). */
declare function isValidAmount(amount: string): boolean;
/**
 * Decimal-safe `a >= b` for x402 amount strings (non-negative, ≤10dp). Compares
 * via integer scaling with BigInt — no float rounding. Returns false if either
 * string is not a valid amount, so a malformed input never reads as "enough".
 */
declare function amountGte(a: string, b: string): boolean;
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
 * The transfer a prepared transaction authorizes, decoded out of the opaque
 * `preparedTransaction` blob. Checked against the requirements by the verifier.
 */
interface DecodedTransfer {
    /** Paying party — must equal the payment payload's `payer`. */
    sender: string;
    /** Receiving party — must equal `requirements.payTo`. */
    receiver: string;
    /** Transfer amount as a decimal string — must be ≥ `requirements.maxAmountRequired`. */
    amount: string;
    /** Instrument moved — must equal `requirements.asset.instrumentId`. */
    instrumentId: {
        id: string;
        admin: string;
    };
}
/**
 * Decode the `preparedTransaction` blob (base64) into the transfer it authorizes,
 * or `null` if it can't be decoded or contains no `TransferFactory_Transfer`
 * exercise. Never throws — an undecodable blob is treated as "no proof of a
 * matching transfer" and rejected upstream.
 */
declare function decodePreparedTransaction(preparedTransactionBase64: string): DecodedTransfer | null;

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
/**
 * Check a decoded transfer against the requirements. Returns `null` when the
 * transfer satisfies them, or a short field detail (`"sender" | "receiver" |
 * "instrument" | "amount"`) naming the first divergence — surfaced in the
 * `transfer_mismatch` response's `extensions.detail`. Overpayment is allowed
 * (`amount >= maxAmountRequired`); the amount compare is decimal-safe.
 */
declare function findTransferMismatch(transfer: DecodedTransfer, requirements: CantonPaymentRequirements, payer: string): "sender" | "receiver" | "instrument" | "amount" | null;
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

export { type AssetSpec, AssetSpecSchema, type CantonPaymentInner, CantonPaymentInnerSchema, type CantonPaymentObject, type CantonPaymentObjectRequest, CantonPaymentObjectRequestSchema, type CantonPaymentObjectResponse, CantonPaymentObjectResponseSchema, CantonPaymentObjectSchema, type CantonPaymentPayload, CantonPaymentPayloadSchema, type CantonPaymentRequiredResponse, CantonPaymentRequiredResponseSchema, type CantonPaymentRequirements, CantonPaymentRequirementsSchema, DEVNET_DSO_PARTY, DEVNET_NETWORK, DEVNET_SYNCHRONIZER_ID, type DecodedPaymentHeader, type DecodedTransfer, type DisclosedContract, DisclosedContractSchema, HashingSchemeVersion, type InstrumentId, InstrumentIdSchema, MAINNET_DSO_PARTY, MAINNET_NETWORK, MAINNET_SYNCHRONIZER_ID, type NetworkId, type Scheme, type SchemeVerifier, type SettleErrorReason, SettleErrorReasonSchema, type SettleRequest, type SettleResponse, type SettleResponseError, SettleResponseErrorSchema, SettleResponseSchema, type SettleResponseSuccess, SettleResponseSuccessSchema, type SupportedKind, SupportedKindSchema, type SupportedResponse, SupportedResponseSchema, type VerifierRegistry, type VerifyInvalidReason, VerifyInvalidReasonSchema, type VerifyRequest, VerifyRequestSchema, type VerifyResponse, type VerifyResponseInvalid, VerifyResponseInvalidSchema, VerifyResponseSchema, type VerifyResponseValid, VerifyResponseValidSchema, X402PaymentEnvelopeSchema, type X402PaymentPayload, type X402PaymentRequiredResponse, type X402PaymentRequirements, type X402Request, type X402Version, amountGte, amuletAsset, createExactCantonVerifier, createVerifierRegistry, decodePaymentHeader, decodePreparedTransaction, encodePaymentHeader, findTransferMismatch, fingerprintForPublicKey, isCantonNetworkId, isCantonPaymentInner, isCantonPaymentRequirements, isCantonVerifyRequest, isExpired, isValidAmount, isX402PaymentPayload, isX402Request, matchesFingerprint, parseCantonNetworkId, parseCantonPaymentInner, parseCantonPaymentRequirements, parseCantonVerifyRequest, parseX402Request, requirementsHash, requirementsHashMatches, schemeNetworkMatches, signHash, verifySignature };
