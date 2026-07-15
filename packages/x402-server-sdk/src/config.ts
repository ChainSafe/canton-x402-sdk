import { DEVNET_NETWORK, MAINNET_NETWORK } from "@chainsafe/x402-core";

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
 * The Canton network values a payer needs: the network id (for `X402Payer`), plus
 * the endpoints/auth used to build the wallet-sdk `SDK` (`SDK.create`). Every field
 * is overridable; deployment-specific URLs are required where there's no safe default.
 */
export interface CantonNetworkConfig {
  /** Network id, e.g. `canton:1220…`. */
  network: string;
  /** JSON Ledger API base URL (`SDK.create({ ledgerClientUrl })`). */
  ledgerClientUrl: string;
  /** Token Standard registry URL (`token.transfer.create({ registryUrl })`). */
  registryUrl: string;
  /** Auth defaults for `SDK.create`. */
  auth: AuthDefaults;
}

const CN_AUDIENCE = "https://canton.network.global";

/**
 * LocalNet: URLs are the well-known `localNetStaticConfig` defaults, but the network
 * id is per-instance (the local synchronizer's fingerprint), so pass `network`.
 */
export function localnetConfig(
  opts: { network: string } & Partial<Omit<CantonNetworkConfig, "network">>,
): CantonNetworkConfig {
  return {
    network: opts.network,
    ledgerClientUrl: opts.ledgerClientUrl ?? "http://localhost:2975",
    registryUrl: opts.registryUrl ?? "http://localhost:2000/api/validator/v0/scan-proxy",
    auth: opts.auth ?? { audience: CN_AUDIENCE, scope: "", issuer: "unsafe-auth" },
  };
}

/**
 * DevNet: the network id is fixed (from x402-core), but ledger/registry URLs are
 * deployment-specific (your validator/scan), so pass them.
 */
export function devnetConfig(
  opts: { ledgerClientUrl: string; registryUrl: string } & Partial<CantonNetworkConfig>,
): CantonNetworkConfig {
  return {
    network: opts.network ?? DEVNET_NETWORK,
    ledgerClientUrl: opts.ledgerClientUrl,
    registryUrl: opts.registryUrl,
    auth: opts.auth ?? { audience: CN_AUDIENCE, scope: "" },
  };
}

/** MainNet: fixed network id (from x402-core); ledger/registry URLs are deployment-specific. */
export function mainnetConfig(
  opts: { ledgerClientUrl: string; registryUrl: string } & Partial<CantonNetworkConfig>,
): CantonNetworkConfig {
  return {
    network: opts.network ?? MAINNET_NETWORK,
    ledgerClientUrl: opts.ledgerClientUrl,
    registryUrl: opts.registryUrl,
    auth: opts.auth ?? { audience: CN_AUDIENCE, scope: "" },
  };
}
