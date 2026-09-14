import type { NetworkId, X402PaymentPayload, X402PaymentRequirements } from "@chainsafe/x402-core";

/**
 * The scheme id this package implements: the x402 `exact` scheme on the
 * `casper:*` CAIP-2 family, as used by the Casper x402 ecosystem
 * (@make-software/casper-x402). Distinct from `exact-canton` in the registry
 * because dispatch is on the (scheme, network) pair.
 */
export const EXACT_CASPER_SCHEME_ID = "exact";

// ─── networks ────────────────────────────────────────────────────────────────
// CAIP-2-style network ids for the Casper Network (x402 v2).

/** Casper MainNet. */
export const CASPER_MAINNET_NETWORK: NetworkId = "casper:casper";
/** Casper TestNet. */
export const CASPER_TESTNET_NETWORK: NetworkId = "casper:casper-test";

/** True iff `x` is a `casper:<chain-name>` network id. */
export function isCasperNetworkId(x: unknown): x is NetworkId {
  return typeof x === "string" && /^casper:.+/.test(x);
}

export function parseCasperNetworkId(s: string): NetworkId {
  if (!isCasperNetworkId(s)) throw new Error(`not a casper network id: ${s}`);
  return s;
}

// ─── asset ───────────────────────────────────────────────────────────────────

/**
 * Casper asset descriptor (the `TAsset` seam of the generic requirements): a
 * CEP-18 fungible-token contract. The reference settlement asset is wCSPR
 * (wrapped CSPR as a CEP-18 token).
 */
export interface CasperAssetSpec {
  /** CEP-18 contract hash, e.g. `hash-<64 hex chars>`. */
  contractHash: string;
  /** Optional human-readable token symbol, e.g. `wCSPR`. */
  symbol?: string;
}

/** wCSPR (CEP-18) asset for a given contract hash. */
export function wcsprAsset(contractHash: string): CasperAssetSpec {
  return { contractHash, symbol: "wCSPR" };
}

// ─── wire types ──────────────────────────────────────────────────────────────

/**
 * The EIP-712 style `transfer_with_authorization` message a Casper wallet signs
 * (casper-eip-712 typed data over a CEP-18 transfer). Mirrors the upstream
 * x402 `exact` scheme authorization shape.
 */
export interface CasperTransferAuthorization {
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
export interface CasperPaymentInner {
  /** Hex signature over the casper-eip-712 typed data of `authorization`. */
  signature: string;
  /** Hex public key of the signer (algorithm-tagged Casper public key). */
  publicKey: string;
  authorization: CasperTransferAuthorization;
}

/** exact/casper payload: the X-PAYMENT envelope carrying a {@link CasperPaymentInner}. */
export type CasperPaymentPayload = X402PaymentPayload<CasperPaymentInner>;

/** exact/casper requirements: a CEP-18 {@link CasperAssetSpec}, sent in the 402's accepts[]. */
export type CasperPaymentRequirements = X402PaymentRequirements<CasperAssetSpec>;
