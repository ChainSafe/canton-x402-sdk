// Getting started, the buyer side: the "Putting it together" block.
//
// Transcluded into docs/getting-started.md (only the `snippet` region is
// shown), and compiled by `pnpm typecheck` but never run: no ledger, no
// credentials, no network. Edit the code in this file, not in the page (#69).

// #region snippet
import { SDK } from "@canton-network/wallet-sdk";
import { CantonX402Payer, createX402Fetch, devnetConfig } from "@chainsafe/x402-server-sdk";

const net = devnetConfig({ ledgerClientUrl: process.env.LEDGER_CLIENT_URL! });
const registryUrl = process.env.AMULET_REGISTRY_URL!; // Amulet Token Standard registry
const DSO_PARTY = "DSO::1220be58c2…"; // from GET /v2/supported

// OAuth2 for your participant's Ledger API (localnet uses method: "self_signed").
const auth = {
  method: "client_credentials",
  configUrl: process.env.CANTON_OAUTH_CONFIG_URL!,
  credentials: {
    clientId: process.env.CANTON_OAUTH_CLIENT_ID!,
    clientSecret: process.env.CANTON_OAUTH_CLIENT_SECRET!,
    scope: net.auth.scope,
    audience: net.auth.audience,
  },
} as const;

const sdk = await SDK.create({
  auth,
  ledgerClientUrl: net.ledgerClientUrl,
  token: { auth, registries: [registryUrl] },
});

const payer = new CantonX402Payer({
  sdk,
  key: {
    partyId: process.env.PAYER_PARTY_ID!,
    publicKey: process.env.PAYER_PUBLIC_KEY!,
    privateKey: process.env.PAYER_PRIVATE_KEY!,
  },
  network: net.network,
  registries: [{ instrumentId: { id: "Amulet", admin: DSO_PARTY }, registryUrl }],
});

// A fetch that pays 402s automatically.
const pay = createX402Fetch(payer);

// Call the gated endpoint — the 402 is paid and the request retried for you.
const res = await pay("https://api.example.com/paid");
const data = await res.json();
console.log(data);
// #endregion snippet
