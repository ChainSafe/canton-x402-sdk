// Builds the x402 payer + an auto-paying fetch for the mortgage backend.
//
// The backend pays the credit bureau per credit-score pull. This wires
// @chainsafe/x402-server-sdk's CantonX402Payer (which prepares + Ed25519-signs a
// Canton Coin transfer via @canton-network/wallet-sdk) into `createX402Fetch`, so
// a 402 from the bureau is paid transparently. Network (localnet/devnet/mainnet)
// and all credentials come from env — see examples/mortgage/.env.example.
//
// SPDX-License-Identifier: Apache-2.0

import { SDK, type TokenProviderConfig } from "@canton-network/wallet-sdk";
import {
  CantonX402Payer,
  createX402Fetch,
  devnetConfig,
  localnetConfig,
  mainnetConfig,
  type CantonNetworkConfig,
  type FetchLike,
} from "@chainsafe/x402-server-sdk";
import { DEVNET_DSO_PARTY, MAINNET_DSO_PARTY, type NetworkId } from "@chainsafe/x402-core";

const NETWORK = (process.env.NETWORK ?? "localnet").toLowerCase();

/** Require an env var, with a clear error naming what's missing. */
function req(value: string | undefined, name: string): string {
  if (!value || !value.trim()) {
    throw new Error(`mortgage-backend: ${name} is required for NETWORK=${NETWORK} (see examples/mortgage/.env.example)`);
  }
  return value.trim();
}

/** The Canton connection preset for the chosen network. */
function netConfig(): CantonNetworkConfig {
  const ledgerClientUrl = process.env.LEDGER_CLIENT_URL;
  if (NETWORK === "devnet") return devnetConfig({ ledgerClientUrl: req(ledgerClientUrl, "LEDGER_CLIENT_URL") });
  if (NETWORK === "mainnet") return mainnetConfig({ ledgerClientUrl: req(ledgerClientUrl, "LEDGER_CLIENT_URL") });
  return localnetConfig({
    network: req(process.env.NETWORK_ID, "NETWORK_ID") as NetworkId,
    ...(ledgerClientUrl ? { ledgerClientUrl } : {}),
  });
}

/** The wallet-sdk auth config: unsafe self-signed on LocalNet, OAuth2 elsewhere. */
function authConfig(net: CantonNetworkConfig): TokenProviderConfig {
  if (NETWORK === "localnet") {
    return {
      method: "self_signed",
      issuer: net.auth.issuer ?? "unsafe-auth",
      credentials: {
        clientId: "ledger-api-user",
        clientSecret: "unsafe",
        scope: net.auth.scope,
        audience: net.auth.audience,
      },
    };
  }
  return {
    method: "client_credentials",
    configUrl: req(process.env.CANTON_OAUTH_CONFIG_URL, "CANTON_OAUTH_CONFIG_URL"),
    credentials: {
      clientId: req(process.env.CANTON_OAUTH_CLIENT_ID, "CANTON_OAUTH_CLIENT_ID"),
      clientSecret: req(process.env.CANTON_OAUTH_CLIENT_SECRET, "CANTON_OAUTH_CLIENT_SECRET"),
      scope: net.auth.scope,
      audience: net.auth.audience,
    },
  };
}

/** DSO party (Amulet asset admin) — defaulted per network; LocalNet passes it. */
function dsoParty(): string {
  if (process.env.DSO_PARTY) return process.env.DSO_PARTY;
  if (NETWORK === "devnet") return DEVNET_DSO_PARTY;
  if (NETWORK === "mainnet") return MAINNET_DSO_PARTY;
  return req(undefined, "DSO_PARTY");
}

/**
 * Construct the payer and return an auto-paying `fetch`. Called once at startup
 * (SDK.create is async and connects to the participant's Ledger API).
 */
export async function buildX402Fetch(): Promise<FetchLike> {
  const net = netConfig();
  const auth = authConfig(net);
  const registryUrl = req(process.env.AMULET_REGISTRY_URL, "AMULET_REGISTRY_URL");
  const dso = dsoParty();

  const sdk = await SDK.create({
    auth,
    ledgerClientUrl: net.ledgerClientUrl,
    token: { auth, registries: [registryUrl] },
  });

  const payer = new CantonX402Payer({
    sdk,
    key: {
      partyId: req(process.env.PAYER_PARTY_ID, "PAYER_PARTY_ID"),
      publicKey: req(process.env.PAYER_PUBLIC_KEY, "PAYER_PUBLIC_KEY"),
      privateKey: req(process.env.PAYER_PRIVATE_KEY, "PAYER_PRIVATE_KEY"),
    },
    network: net.network,
    registries: [{ instrumentId: { id: "Amulet", admin: dso }, registryUrl }],
  });

  console.log(`[mortgage-backend] payer ready — network=${NETWORK}, party=${process.env.PAYER_PARTY_ID}`);
  return createX402Fetch(payer);
}
