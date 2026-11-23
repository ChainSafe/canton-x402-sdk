---
description: Pay x402 endpoints from an agent, service or backend with @chainsafe/x402-server-sdk — authenticating per network, the payer, the auto-pay fetch, and writing your own payer.
---

# Paying from your service

`@chainsafe/x402-server-sdk` pays from anything that holds a Canton party's
Ed25519 key and can reach a participant's Ledger API: an agent, a service, a
backend. It prepares and signs the transfer; it never executes it. That is the
facilitator's job, and it can only submit what the payer signed.
[Pay for an API](/get-started/pay-for-an-api) is the short version; this page
is the rest.

Paying from a user's browser wallet is a different path, through a wallet
connection, and is not covered by this package.

```bash
npm install @chainsafe/x402-server-sdk @canton-network/wallet-sdk
```

## Connect and build the payer

```ts
import { SDK, type TokenProviderConfig } from "@canton-network/wallet-sdk";
import { CantonX402Payer, createX402Fetch, devnetConfig } from "@chainsafe/x402-server-sdk";

const net = devnetConfig({ ledgerClientUrl: "https://<your-participant>/…" });

// Token Standard registries are per asset. Amulet's is your validator's
// scan-proxy; a registry token such as USDCx has its own.
const amuletRegistry = "https://<your-validator>/api/validator/v0/scan-proxy";

const auth: TokenProviderConfig = {
  method: "client_credentials",
  configUrl: process.env.CANTON_OAUTH_CONFIG_URL!, // OIDC discovery URL
  credentials: {
    clientId: process.env.CANTON_OAUTH_CLIENT_ID!,
    clientSecret: process.env.CANTON_OAUTH_CLIENT_SECRET!,
    scope: net.auth.scope,
    audience: net.auth.audience,
  },
};

const sdk = await SDK.create({
  auth,
  ledgerClientUrl: net.ledgerClientUrl,
  token: { auth, registries: [amuletRegistry] },
});

const payer = new CantonX402Payer({
  sdk,
  key: { partyId: "payer::1220…", privateKey: "<base64 seed>" },
  network: net.network,
  registries: [
    // one entry per asset it pays in
    { instrumentId: { id: "Amulet", admin: "DSO::1220…" }, registryUrl: amuletRegistry },
  ],
});

const paidFetch = createX402Fetch(payer);
const res = await paidFetch("https://api.example/paid"); // 402 → pay → retry
```

- **`key`** is the party id and its Ed25519 private key (the 32-byte seed, base64).
  There is no public key to pass: the facilitator reads the party's key from
  the ledger.
- **`network`** must be the network the merchant's facilitator reports from
  `/v2/supported`; the payer only pays requirements on its own network.
- **`registries`** gives each asset's instrument id and registry. The DSO party
  for Amulet is `extra.instruments[].instrumentId.admin` in the facilitator's
  `/v2/supported`.

### Network presets and auth

`localnetConfig`, `devnetConfig` and `mainnetConfig` return
`{ network, ledgerClientUrl, auth }` for `SDK.create`. LocalNet needs no
arguments; DevNet and MainNet take your participant's ledger URL. Every field can
be overridden. Registries are not part of the preset, because they are per
asset.

On DevNet, TestNet and MainNet, authenticate with OAuth2 client credentials from
your validator operator, as above. LocalNet has no identity provider and uses a
self-signed token:

```ts
const auth: TokenProviderConfig = {
  method: "self_signed",
  issuer: "unsafe-auth",
  credentials: {
    clientId: "ledger-api-user",
    clientSecret: "unsafe",
    scope: net.auth.scope,
    audience: net.auth.audience,
  },
};
```

## What `authorize` does

`payer.authorize(requirements)` turns one `accepts[]` entry into a payment:

1. Checks the requirement: amount, scheme, network, `extra.assetTransferMethod`
   and expiry.
2. Builds the Token Standard transfer, which fetches the transfer factory from
   the asset's registry.
3. Prepares it on your participant (interactive submission), which returns the
   transaction and its hash.
4. Signs the hash with the party key.
5. Assembles the payment: the requirements it answers as `accepted`, and the
   gzipped prepared transaction, its hash and the signature. Nothing is
   executed, and the payment names no payer: the facilitator takes the
   transfer's sender.

The payer keeps no state. A payment cannot be settled twice: the ledger refuses
a transfer whose input holdings are already spent, and the facilitator refuses a
second settle under a memo it has already settled.

## The auto-pay fetch

`createX402Fetch(payer)` wraps `fetch`: it calls the resource, and on a `402`
picks a requirement, pays it and retries with the payment in
`PAYMENT-SIGNATURE`. Any other response, and a `402` the payer cannot satisfy,
passes through unchanged.

- **Several payers:** `createX402Fetch([cantonPayer, otherPayer])` routes each
  advertised requirement to the first payer that `supports()` it, in the
  server's `accepts[]` order. Pass `select(accepts, payers)` to choose
  differently, and `fetch` to wrap a custom fetch.
- **Request bodies must be re-readable**, because the paid request is sent
  again: a string, JSON, a `Buffer` or `URLSearchParams`, not a `ReadableStream`
  or a `Request` whose body the first call consumes.
- **Don't retry a pending payment.** A `402` whose `PAYMENT-RESPONSE` is
  `settlement_pending` may still land, and retrying through the wrapper signs a
  new payment. See [Pending settlements](/guides/pending-settlements).

## Writing your own payer

`createX402Fetch` depends only on the `X402Payer` contract, not on Canton:

```ts
interface X402Payer {
  // scheme + network + transfer method + asset
  supports(requirements: CantonPaymentRequirements): boolean;
  authorize(
    requirements: CantonPaymentRequirements,
    context?: PaymentContext, // { resource? }: what the 402 named
  ): Promise<CantonPaymentPayload>;
}
```

`authorize` must return a payment whose `accepted` is the `requirements` it was
given, whole: the wrapper sends the payment alone, and the merchant takes the
requirements to verify from it.

## Settling yourself

`FacilitatorClient` is re-exported for a service that drives verify and settle
itself; see [Calling the facilitator](/guides/calling-the-facilitator).
