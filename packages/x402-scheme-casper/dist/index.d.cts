import {
  NetworkId,
  X402PaymentPayload,
  X402PaymentRequirements,
  SchemeVerifier,
  VerifyResponse,
  SettleResponse,
  X402Request,
} from "@chainsafe/x402-core";

/**
 * The scheme id this package implements: the x402 `exact` scheme on the
 * `casper:*` CAIP-2 family, as used by the Casper x402 ecosystem
 * (@make-software/casper-x402). Distinct from `exact-canton` in the registry
 * because dispatch is on the (scheme, network) pair.
 */
declare const EXACT_CASPER_SCHEME_ID = "exact";
/** Casper MainNet. */
declare const CASPER_MAINNET_NETWORK: NetworkId;
/** Casper TestNet. */
declare const CASPER_TESTNET_NETWORK: NetworkId;
/** True iff `x` is a `casper:<chain-name>` network id. */
declare function isCasperNetworkId(x: unknown): x is NetworkId;
declare function parseCasperNetworkId(s: string): NetworkId;
/**
 * Casper asset descriptor (the `TAsset` seam of the generic requirements): a
 * CEP-18 fungible-token contract. The reference settlement asset is wCSPR
 * (wrapped CSPR as a CEP-18 token).
 */
interface CasperAssetSpec {
  /** CEP-18 contract hash, e.g. `hash-<64 hex chars>`. */
  contractHash: string;
  /** Optional human-readable token symbol, e.g. `wCSPR`. */
  symbol?: string;
}
/** wCSPR (CEP-18) asset for a given contract hash. */
declare function wcsprAsset(contractHash: string): CasperAssetSpec;
/**
 * The EIP-712 style `transfer_with_authorization` message a Casper wallet signs
 * (casper-eip-712 typed data over a CEP-18 transfer). Mirrors the upstream
 * x402 `exact` scheme authorization shape.
 */
interface CasperTransferAuthorization {
  /** Paying account: public key hex or `account-hash-<hex>`. */
  from: string;
  /** Recipient account; must equal the requirements' `payTo`. */
  to: string;
  /** Token amount in the CEP-18 token's smallest unit (decimal string). */
  value: string;
  /** Unix seconds (decimal string) before which the authorization is not valid. */
  validAfter: string;
  /** Unix seconds (decimal string) at/after which the authorization is expired. */
  validBefore: string;
  /** Unique nonce (hex) — replay protection, checked statefully by the facilitator. */
  nonce: string;
}
/**
 * The inner payload a wallet packs into the X-PAYMENT header for the Casper
 * `exact` scheme: the signed authorization plus its signature material.
 */
interface CasperPaymentInner {
  /** Hex signature over the casper-eip-712 typed data of `authorization`. */
  signature: string;
  /** Hex public key of the signer (algorithm-tagged Casper public key). */
  publicKey: string;
  authorization: CasperTransferAuthorization;
}
/** exact/casper payload: the X-PAYMENT envelope carrying a {@link CasperPaymentInner}. */
type CasperPaymentPayload = X402PaymentPayload<CasperPaymentInner>;
/** exact/casper requirements: a CEP-18 {@link CasperAssetSpec}, sent in the 402's accepts[]. */
type CasperPaymentRequirements = X402PaymentRequirements<CasperAssetSpec>;

declare function isCasperPaymentRequirements(v: unknown): v is CasperPaymentRequirements;
declare function isCasperPaymentInner(v: unknown): v is CasperPaymentInner;
/**
 * Build an exact/casper {@link SchemeVerifier} bound to a specific Casper
 * network (`casper:casper` or `casper:casper-test`). The registry dispatches
 * on `(schemeId, networkId)`.
 */
declare function createExactCasperVerifier(networkId: NetworkId): SchemeVerifier;

/** Default hosted facilitator for the Casper Network. */
declare const DEFAULT_CASPER_FACILITATOR_URL = "https://x402-facilitator.cspr.cloud";
/** exact/casper verify/settle request envelope. */
type CasperX402Request = X402Request<CasperPaymentInner, CasperAssetSpec>;
interface CasperFacilitatorClientOptions {
  /** Optional API key, sent as `Authorization: Bearer <apiKey>` when set. */
  apiKey?: string | (() => string | Promise<string>);
  /** Abort a request that exceeds this many ms. Omit for no timeout. */
  timeoutMs?: number;
}
/**
 * A facilitator call that did not yield a domain response: a `4xx`/`5xx` or a
 * transport/network failure. An *evaluated-but-invalid* payment is NOT this —
 * the facilitator returns `200` with `{isValid:false}` / `{success:false}`.
 */
declare class CasperFacilitatorError extends Error {
  /** The endpoint path, e.g. `/verify`. */
  readonly endpoint: string;
  /** HTTP status, or `0` for a network/timeout failure (no response). */
  readonly status: number;
  /** Parsed JSON error body if any, else the raw text, else `undefined`. */
  readonly body: unknown;
  constructor(
    /** The endpoint path, e.g. `/verify`. */
    endpoint: string,
    /** HTTP status, or `0` for a network/timeout failure (no response). */
    status: number,
    /** Parsed JSON error body if any, else the raw text, else `undefined`. */
    body: unknown,
    options?: {
      cause?: unknown;
    },
  );
}
/** Thin client for a Casper x402 facilitator's verify / settle API. */
declare class CasperFacilitatorClient {
  private readonly opts;
  private readonly base;
  /**
   * @param facilitatorUrl Base URL of the facilitator; a trailing slash is
   *   trimmed. Defaults to {@link DEFAULT_CASPER_FACILITATOR_URL}.
   * @param opts Optional API key + request timeout.
   */
  constructor(facilitatorUrl?: string, opts?: CasperFacilitatorClientOptions);
  /**
   * POST /verify — dry-run validation without settling. Resolves with the
   * verdict (`isValid` true or false); throws {@link CasperFacilitatorError}
   * only on a protocol/transport error.
   */
  verify(
    payload: CasperPaymentPayload,
    requirements: CasperPaymentRequirements,
  ): Promise<VerifyResponse>;
  /**
   * POST /settle — submit the CEP-18 `transfer_with_authorization` on-chain.
   * Resolves with the outcome (`success` true or false); throws
   * {@link CasperFacilitatorError} only on a protocol/transport error.
   */
  settle(
    payload: CasperPaymentPayload,
    requirements: CasperPaymentRequirements,
  ): Promise<SettleResponse>;
  private postDomain;
  private authHeaders;
}

export {
  CASPER_MAINNET_NETWORK,
  CASPER_TESTNET_NETWORK,
  type CasperAssetSpec,
  CasperFacilitatorClient,
  type CasperFacilitatorClientOptions,
  CasperFacilitatorError,
  type CasperPaymentInner,
  type CasperPaymentPayload,
  type CasperPaymentRequirements,
  type CasperTransferAuthorization,
  type CasperX402Request,
  DEFAULT_CASPER_FACILITATOR_URL,
  EXACT_CASPER_SCHEME_ID,
  createExactCasperVerifier,
  isCasperNetworkId,
  isCasperPaymentInner,
  isCasperPaymentRequirements,
  parseCasperNetworkId,
  wcsprAsset,
};
