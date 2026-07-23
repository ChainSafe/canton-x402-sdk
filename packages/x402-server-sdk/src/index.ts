/**
 * @chainsafe/x402-server-sdk
 *
 * Payer SDK: with a Canton party key + a wallet-sdk ledger connection, prepare +
 * sign a Canton Coin transfer and produce the X-PAYMENT payload a facilitator settles.
 */
export const VERSION = "0.0.1";

export { type X402Payer } from "./payer.js";
export { createX402Fetch, type X402FetchOptions, type X402Selection, type FetchLike } from "./fetch.js";
export {
  CantonX402Payer,
  type CantonX402PayerOptions,
  type CantonPartyKey,
  type AssetRegistry,
} from "./canton-payer.js";
export {
  localnetConfig,
  devnetConfig,
  mainnetConfig,
  type CantonNetworkConfig,
  type AuthDefaults,
} from "./canton-config.js";

// The facilitator client is the same one merchants use — re-exported for consumers
// that also drive verify/settle themselves.
export { FacilitatorClient, FacilitatorError, type FacilitatorClientOptions } from "@chainsafe/x402-client";
