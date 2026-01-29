// Shared environment loader for example apps

import { config as dotenvConfig } from "dotenv";
import { localnetConfig } from "canton-x402-sdk";
import type { CantonSdkConfig } from "canton-x402-sdk";

export interface EnvResult {
  config: CantonSdkConfig;
  payerConfig: CantonSdkConfig;
  payeeConfig: CantonSdkConfig;
  payerParty: string;
  payeeParty: string;
  dsoParty: string;
}

export function loadEnv(envPath?: string): EnvResult {
  dotenvConfig({ path: envPath ?? ".env" });

  const payerParty = process.env.PAYER_PARTY ?? "";
  const payeeParty = process.env.PAYEE_PARTY ?? "";
  const dsoParty = process.env.CANTON_DSO_PARTY ?? "";

  if (!payerParty || !payeeParty) {
    console.error(
      "Missing PAYER_PARTY or PAYEE_PARTY in .env. Run the setup script first:",
    );
    console.error("  cd examples/shared && npx tsx setup.ts");
    process.exit(1);
  }

  const payerTokenUrl = process.env.PAYER_TOKEN_URL ?? "";
  const payerClientId = process.env.PAYER_CLIENT_ID ?? "";
  const payerClientSecret = process.env.PAYER_CLIENT_SECRET ?? "";
  const payeeTokenUrl = process.env.PAYEE_TOKEN_URL ?? "";
  const payeeClientId = process.env.PAYEE_CLIENT_ID ?? "";
  const payeeClientSecret = process.env.PAYEE_CLIENT_SECRET ?? "";

  const ledgerUrlUser =
    process.env.CANTON_LEDGER_URL_USER ?? "http://localhost:2975";
  const ledgerUrlProvider =
    process.env.CANTON_LEDGER_URL_PROVIDER ?? "http://localhost:3975";
  const scanProxyUrl =
    process.env.CANTON_SCAN_PROXY_URL ?? "http://scan.localhost:4000";

  const useOAuth2 = payerTokenUrl && payerClientId && payerClientSecret;

  const payerConfig = localnetConfig({
    dsoParty,
    ledgerApiUrl: ledgerUrlUser,
    scanProxyUrl,
    auth: useOAuth2
      ? {
          type: "oauth2",
          tokenUrl: payerTokenUrl,
          clientId: payerClientId,
          clientSecret: payerClientSecret,
          audience: "https://canton.network.global",
          scope: "openid",
        }
      : {
          type: "shared-secret",
          secret: "unsafe",
          userId: process.env.PAYER_USER_ID ?? "app-user",
          audience: "https://canton.network.global",
        },
  });

  const payeeConfig = localnetConfig({
    dsoParty,
    ledgerApiUrl: ledgerUrlProvider,
    scanProxyUrl,
    auth:
      useOAuth2 && payeeTokenUrl && payeeClientId && payeeClientSecret
        ? {
            type: "oauth2",
            tokenUrl: payeeTokenUrl,
            clientId: payeeClientId,
            clientSecret: payeeClientSecret,
            audience: "https://canton.network.global",
            scope: "openid",
          }
        : {
            type: "shared-secret",
            secret: "unsafe",
            userId: process.env.PAYEE_USER_ID ?? "app-provider",
            audience: "https://canton.network.global",
          },
  });

  return {
    config: payerConfig,
    payerConfig,
    payeeConfig,
    payerParty,
    payeeParty,
    dsoParty,
  };
}
