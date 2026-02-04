// Canton x402 SDK -- Network Configuration Presets

import type { CantonSdkConfig } from "./types.js";

/**
 * Validate a Canton SDK config for production safety.
 * Rejects unsafe secrets on non-local networks and insecure OAuth URLs.
 */
export function validateConfig(config: CantonSdkConfig): void {
  const isLocal = config.network === "canton-local";

  if (config.auth.type === "shared-secret") {
    if (!isLocal && config.auth.secret === "unsafe") {
      throw new Error(
        `Shared secret "unsafe" is not allowed on network "${config.network}". ` +
        `Use a strong secret or switch to OAuth2.`,
      );
    }
  }

  if (config.auth.type === "oauth2") {
    if (!config.auth.tokenUrl) {
      throw new Error("OAuth2 tokenUrl is required");
    }
    if (!config.auth.clientId) {
      throw new Error("OAuth2 clientId is required");
    }
    if (!config.auth.clientSecret) {
      throw new Error("OAuth2 clientSecret is required");
    }
    if (!isLocal && !config.auth.tokenUrl.startsWith("https://")) {
      throw new Error(
        `OAuth2 tokenUrl must use HTTPS on network "${config.network}": ${config.auth.tokenUrl}`,
      );
    }
  }

  if (!config.ledgerApiUrl) {
    throw new Error("ledgerApiUrl is required");
  }
  if (!isLocal && config.ledgerApiUrl.startsWith("http://")) {
    throw new Error(
      `ledgerApiUrl must use HTTPS on network "${config.network}": ${config.ledgerApiUrl}`,
    );
  }
}

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

/**
 * Mainnet configuration.
 * All values must come from environment variables -- no defaults.
 * Enforces HTTPS and validates config on construction.
 */
export function mainnetConfig(
  overrides: Partial<CantonSdkConfig> = {},
): CantonSdkConfig {
  const ledgerApiUrl = process.env.CANTON_LEDGER_API_URL;
  const scanProxyUrl = process.env.CANTON_SCAN_PROXY_URL;
  const dsoParty = process.env.CANTON_DSO_PARTY;
  const tokenUrl = process.env.CANTON_OAUTH_TOKEN_URL;
  const clientId = process.env.CANTON_OAUTH_CLIENT_ID;
  const clientSecret = process.env.CANTON_OAUTH_CLIENT_SECRET;

  if (!ledgerApiUrl) throw new Error("CANTON_LEDGER_API_URL is required for mainnet");
  if (!scanProxyUrl) throw new Error("CANTON_SCAN_PROXY_URL is required for mainnet");
  if (!dsoParty) throw new Error("CANTON_DSO_PARTY is required for mainnet");
  if (!tokenUrl) throw new Error("CANTON_OAUTH_TOKEN_URL is required for mainnet");
  if (!clientId) throw new Error("CANTON_OAUTH_CLIENT_ID is required for mainnet");
  if (!clientSecret) throw new Error("CANTON_OAUTH_CLIENT_SECRET is required for mainnet");

  const config: CantonSdkConfig = {
    network: "canton-mainnet",
    ledgerApiUrl,
    scanProxyUrl,
    dsoParty,
    auth: {
      type: "oauth2",
      tokenUrl,
      clientId,
      clientSecret,
      audience: process.env.CANTON_OAUTH_AUDIENCE,
      scope: process.env.CANTON_OAUTH_SCOPE,
    },
    ...overrides,
  };

  validateConfig(config);
  return config;
}
