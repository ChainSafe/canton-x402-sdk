import { DEVNET_NETWORK, MAINNET_NETWORK, type NetworkId } from "@chainsafe/x402-core";

/**
 * Auth defaults for building a wallet-sdk `TokenProviderConfig`. The caller adds
 * `method` + `clientId`/`clientSecret` (and `issuer` for `self_signed`).
 */
export interface AuthDefaults {
  audience: string;
  scope: string;
  issuer?: string;
}

/**
 * The Canton connection values a payer needs to build a wallet-sdk `SDK`: the
 * network id (for `X402Payer`) + the ledger endpoint + auth defaults.
 */
export interface CantonNetworkConfig {
  /** Network id, e.g. `canton:1220…`. */
  network: NetworkId;
  /** JSON Ledger API base URL (`SDK.create({ ledgerClientUrl })`). */
  ledgerClientUrl: string;
  /** Auth defaults for `SDK.create`. */
  auth: AuthDefaults;
}

const CN_AUDIENCE = "https://canton.network.global";

/**
 * LocalNet: the ledger URL is the well-known localhost default, but the network id
 * is per-instance (the local synchronizer's fingerprint), so pass `network`.
 */
export function localnetConfig(
  opts: { network: NetworkId } & Partial<Omit<CantonNetworkConfig, "network">>,
): CantonNetworkConfig {
  return {
    network: opts.network,
    ledgerClientUrl: opts.ledgerClientUrl ?? "http://localhost:2975",
    auth: opts.auth ?? { audience: CN_AUDIENCE, scope: "", issuer: "unsafe-auth" },
  };
}

/**
 * DevNet: the network id is fixed (from x402-core); the ledger URL is your own
 * participant, so pass it.
 */
export function devnetConfig(
  opts: { ledgerClientUrl: string } & Partial<CantonNetworkConfig>,
): CantonNetworkConfig {
  return {
    network: opts.network ?? DEVNET_NETWORK,
    ledgerClientUrl: opts.ledgerClientUrl,
    auth: opts.auth ?? { audience: CN_AUDIENCE, scope: "" },
  };
}

/** MainNet: fixed network id (from x402-core); the ledger URL is your own participant. */
export function mainnetConfig(
  opts: { ledgerClientUrl: string } & Partial<CantonNetworkConfig>,
): CantonNetworkConfig {
  return {
    network: opts.network ?? MAINNET_NETWORK,
    ledgerClientUrl: opts.ledgerClientUrl,
    auth: opts.auth ?? { audience: CN_AUDIENCE, scope: "" },
  };
}
