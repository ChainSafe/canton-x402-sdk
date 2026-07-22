import { CantonPaymentRequirements, CantonPaymentPayload, InstrumentId, NetworkId } from '@chainsafe/x402-core';
import { SDKInterface } from '@canton-network/wallet-sdk';
export { FacilitatorClient, FacilitatorClientOptions, FacilitatorError } from '@chainsafe/x402-client';

/**
 * Scheme-agnostic payer contract. The auto-pay fetch wrapper depends on this, not
 * on a specific implementation, so a future scheme's payer drops in without
 * touching it. `CantonX402Payer` (canton-payer.ts) is the exact-canton implementation.
 */
interface X402Payer {
    /** Whether this payer can satisfy a requirement (scheme + network + asset). */
    supports(requirements: CantonPaymentRequirements): boolean;
    /** Prepare + sign a payment, returning the payload a facilitator settles. */
    authorize(requirements: CantonPaymentRequirements): Promise<CantonPaymentPayload>;
}

/** A `fetch`-compatible function. */
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
/** A chosen payer paired with the requirement it will satisfy. */
interface X402Selection {
    payer: X402Payer;
    requirements: CantonPaymentRequirements;
}
interface X402FetchOptions {
    /**
     * Choose which payer pays which advertised requirement. Default: for each
     * `accepts[]` entry in the server's order, the first payer that `supports()` it —
     * so the server's preference order wins and mixed-scheme offers route correctly.
     */
    select?: (accepts: CantonPaymentRequirements[], payers: X402Payer[]) => X402Selection | undefined;
    /** Underlying fetch to wrap. Defaults to the global `fetch`. */
    fetch?: FetchLike;
}
/**
 * Wrap `fetch` so x402 payments are transparent: call the resource, and on a `402`
 * read the accepted requirements, pay via a matching payer, and retry with the
 * `X-PAYMENT` header. Non-402 responses — and 402s no payer can satisfy — pass
 * through unchanged.
 *
 * Accepts one payer or several; with several, each advertised requirement routes to
 * the first payer that `supports()` it (e.g. a Canton payer + an EVM payer). Depends
 * only on the {@link X402Payer} contract, so it's scheme-agnostic.
 *
 * Works for any HTTP method. The paid request is **retried**, so a request body must
 * be re-readable (a value like a string / JSON / `Buffer` / `URLSearchParams`, not a
 * `ReadableStream`, and don't pass a `Request` object whose body the first call consumes).
 *
 * @example
 * const f = createX402Fetch(payer);                 // one payer
 * const f = createX402Fetch([cantonPayer, evmPayer]); // several
 * const res = await f("https://api.example/paid");
 */
declare function createX402Fetch(payers: X402Payer | X402Payer[], opts?: X402FetchOptions): FetchLike;

/** The external party's Ed25519 key material (client-side only). */
interface CantonPartyKey {
    /** Party ID: `<hint>::<fingerprint>`. */
    partyId: string;
    /** Base64 32-byte Ed25519 public key. */
    publicKey: string;
    /** Base64 32-byte Ed25519 seed (private). */
    privateKey: string;
}
/** A supported asset and the Token Standard registry that routes its transfer factory. */
interface AssetRegistry {
    instrumentId: InstrumentId;
    registryUrl: string | URL;
}
interface CantonX402PayerOptions {
    /** A wallet-sdk instance with the token namespace (built via `SDK.create({ ..., token })`). */
    sdk: SDKInterface<"token">;
    /** The paying party's Ed25519 key. */
    key: CantonPartyKey;
    /** The network id this payer's `sdk` is connected to (rejects requirements for others). */
    network: NetworkId;
    /** The assets this payer supports, each with its Token Standard registry. */
    registries: AssetRegistry[];
}
/**
 * Canton exact-canton payer over `@canton-network/wallet-sdk`: builds a Token
 * Standard transfer, prepares it (interactive submission), Ed25519-signs the hash,
 * and assembles the X-PAYMENT payload — without executing (the facilitator settles).
 */
declare class CantonX402Payer implements X402Payer {
    private readonly opts;
    constructor(opts: CantonX402PayerOptions);
    supports(requirements: CantonPaymentRequirements): boolean;
    /** Registry URL for a supported asset, or `undefined` if this payer doesn't carry it. */
    private registryFor;
    authorize(requirements: CantonPaymentRequirements): Promise<CantonPaymentPayload>;
}

/**
 * Auth defaults for building a wallet-sdk `TokenProviderConfig`. The caller adds
 * `method` + `clientId`/`clientSecret` (and `issuer` for `self_signed`).
 */
interface AuthDefaults {
    audience: string;
    scope: string;
    issuer?: string;
}
/**
 * The Canton connection values a payer needs to build a wallet-sdk `SDK`: the
 * network id (for `X402Payer`) + the ledger endpoint + auth defaults.
 */
interface CantonNetworkConfig {
    /** Network id, e.g. `canton:1220…`. */
    network: NetworkId;
    /** JSON Ledger API base URL (`SDK.create({ ledgerClientUrl })`). */
    ledgerClientUrl: string;
    /** Auth defaults for `SDK.create`. */
    auth: AuthDefaults;
}
/**
 * LocalNet: the ledger URL is the well-known localhost default, but the network id
 * is per-instance (the local synchronizer's fingerprint), so pass `network`.
 */
declare function localnetConfig(opts: {
    network: NetworkId;
} & Partial<Omit<CantonNetworkConfig, "network">>): CantonNetworkConfig;
/**
 * DevNet: the network id is fixed (from x402-core); the ledger URL is your own
 * participant, so pass it.
 */
declare function devnetConfig(opts: {
    ledgerClientUrl: string;
} & Partial<CantonNetworkConfig>): CantonNetworkConfig;
/** MainNet: fixed network id (from x402-core); the ledger URL is your own participant. */
declare function mainnetConfig(opts: {
    ledgerClientUrl: string;
} & Partial<CantonNetworkConfig>): CantonNetworkConfig;

/**
 * @chainsafe/x402-server-sdk
 *
 * Payer SDK: with a Canton party key + a wallet-sdk ledger connection, prepare +
 * sign a Canton Coin transfer and produce the X-PAYMENT payload a facilitator settles.
 */
declare const VERSION = "0.0.1";

export { type AssetRegistry, type AuthDefaults, type CantonNetworkConfig, type CantonPartyKey, CantonX402Payer, type CantonX402PayerOptions, type FetchLike, VERSION, type X402FetchOptions, type X402Payer, type X402Selection, createX402Fetch, devnetConfig, localnetConfig, mainnetConfig };
