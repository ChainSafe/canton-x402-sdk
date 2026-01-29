// Canton x402 SDK -- Network Configuration Presets

import type { CantonSdkConfig } from "./types.js";

/**
 * Localnet configuration for cn-quickstart.
 * Uses shared-secret HS256 JWT auth with secret="unsafe".
 */
export function localnetConfig(
  overrides: Partial<CantonSdkConfig> & { userId?: string } = {},
): CantonSdkConfig {
  const userId = overrides.userId ?? "app-user";
  return {
    network: "canton-local",
    ledgerApiUrl: "http://localhost:2975",
    scanProxyUrl: "http://scan.localhost:4000",
    dsoParty: overrides.dsoParty ?? "",
    auth: {
      type: "shared-secret",
      secret: "unsafe",
      userId,
      audience: "https://canton.network.global",
    },
    spliceHoldingPackageId:
      "718a0f77e505a8de22f188bd4c87fe74101274e9d4cb1bfac7d09aec7158d35b",
    ...overrides,
  };
}

/**
 * DevNet configuration for ChainSafe Canton DevNet.
 * Uses OAuth2 client_credentials flow.
 */
export function devnetConfig(
  overrides: Partial<CantonSdkConfig> = {},
): CantonSdkConfig {
  return {
    network: "canton-devnet",
    ledgerApiUrl:
      "https://canton-ledger-api-http-dev1.01.chainsafe.dev/api/json-api",
    scanProxyUrl:
      "https://wallet-validator-dev1.01.chainsafe.dev/api/validator/v0/scan-proxy",
    dsoParty:
      "DSO::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a",
    auth: {
      type: "oauth2",
      tokenUrl: process.env.CANTON_OAUTH_TOKEN_URL ?? "",
      clientId: process.env.CANTON_OAUTH_CLIENT_ID ?? "",
      clientSecret: process.env.CANTON_OAUTH_CLIENT_SECRET ?? "",
      audience: process.env.CANTON_OAUTH_AUDIENCE,
      scope: process.env.CANTON_OAUTH_SCOPE,
    },
    ...overrides,
  };
}
