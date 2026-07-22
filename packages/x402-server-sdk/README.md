# @chainsafe/x402-server-sdk

Payer-side SDK for [x402](https://x402.org) on the Canton Network. With a Canton
party's Ed25519 key and ledger access (via [`@canton-network/wallet-sdk`](https://www.npmjs.com/package/@canton-network/wallet-sdk)),
`X402Payer.authorize(requirements)` prepares and signs a Canton Coin transfer and
returns the `CantonPaymentPayload` a facilitator settles — the payer authorizes, it
never executes.

For entities that hold a party key and have ledger access (agents, services,
backends). Paying from a user's browser wallet (Loop/Console) is a different,
wallet-connection path and out of scope here.

## Install

```bash
npm install @chainsafe/x402-server-sdk @canton-network/wallet-sdk
```

## Quickstart

```ts
import { SDK, type TokenProviderConfig } from "@canton-network/wallet-sdk";
import { CantonX402Payer, devnetConfig } from "@chainsafe/x402-server-sdk";

const net = devnetConfig({ ledgerClientUrl: "https://<your-participant>/…" });

// Your Token Standard registries (asset-specific — you own these). Amulet is the
// validator scan-proxy; other assets (e.g. USDCx) have their own registries.
const amuletRegistry = "https://<your-validator>/api/validator/v0/scan-proxy";

// Auth — see below. DevNet/TestNet/MainNet use OAuth2 client_credentials:
const auth: TokenProviderConfig = {
  method: "client_credentials",
  audience: net.auth.audience,
  scope: net.auth.scope,
  clientId: process.env.CANTON_OAUTH_CLIENT_ID!,
  clientSecret: process.env.CANTON_OAUTH_CLIENT_SECRET!,
};

// 1. Build a wallet-sdk instance with the token namespace.
const sdk = await SDK.create({
  auth,
  ledgerClientUrl: net.ledgerClientUrl,
  token: { auth, registries: [amuletRegistry] },
});

// 2. Construct the payer with your party key + the assets it supports.
const payer = new CantonX402Payer({
  sdk,
  key: { partyId: "payer::1220…", publicKey: "<base64>", privateKey: "<base64 seed>" },
  network: net.network,
  registries: [
    // one entry per supported asset (Amulet here; add USDCx etc. with their registries)
    { instrumentId: { id: "Amulet", admin: "DSO::1220…" }, registryUrl: amuletRegistry },
  ],
});

// 3. On a 402, authorize against the advertised requirements → get the payload.
const payload = await payer.authorize(requirements); // CantonPaymentRequirements from the 402
// hand `payload` to the merchant/facilitator (e.g. via the X-PAYMENT header)
```

### Auth by environment

`SDK.create` takes a wallet-sdk `TokenProviderConfig`. Which `method` depends on the network:

```ts
// LocalNet — unsafe self-signed JWT (no real IdP)
const auth: TokenProviderConfig = {
  method: "self_signed",
  issuer: "unsafe-auth",
  audience: net.auth.audience,
  scope: "",
  clientId: "ledger-api-user",
  clientSecret: "unsafe",
};

// DevNet / TestNet / MainNet — OAuth2 client credentials from your validator operator
const auth: TokenProviderConfig = {
  method: "client_credentials",
  audience: net.auth.audience,
  scope: net.auth.scope,
  clientId: process.env.CANTON_OAUTH_CLIENT_ID!,
  clientSecret: process.env.CANTON_OAUTH_CLIENT_SECRET!,
};
```

Use `localnetConfig`/`devnetConfig`/`mainnetConfig` for the matching network values.

## `X402Payer`

Scheme-agnostic contract (the auto-pay fetch wrapper depends on this, not on the
Canton implementation):

```ts
interface X402Payer {
  supports(requirements: CantonPaymentRequirements): boolean;   // scheme + network + asset
  authorize(requirements: CantonPaymentRequirements): Promise<CantonPaymentPayload>;
}
```

`CantonX402Payer.authorize()`:
- validates the requirement (amount, scheme, network, expiry) via `x402-core`;
- builds the Token Standard transfer (`sdk.token.transfer.create` — routes the
  transfer factory via the registry);
- prepares it (`sdk.ledger.prepare` — interactive submission) to get the hash;
- Ed25519-signs the hash with the party key (`x402-core`'s `signHash`);
- assembles the payload (`requirementsHash`, required `publicKey`, required `hashingSchemeVersion`)
  **without executing** — facilitator derives fingerprint from `publicKey` (`fingerprintForPublicKey`; no `keyFingerprint` on the wire).

`CantonX402Payer` is stateless: double-settle is prevented by the facilitator (it
rejects a reused `nonce`) and Canton (it dedupes execute by a submissionId derived
from the prepared-tx hash), so the payer doesn't track in-flight requests.

## Config presets

`localnetConfig` / `devnetConfig` / `mainnetConfig` return `{ network, ledgerClientUrl, auth }`
to feed `SDK.create`. LocalNet defaults the localhost ledger URL (network id is
per-instance, so pass it); DevNet/MainNet fill the network id from `x402-core` and
take your participant's ledger URL. Every field is overridable. **Registries are not
here** — they're asset-specific (Amulet vs USDCx), so you pass them to `CantonX402Payer`.

## Settling

The payload is settled by a facilitator. `FacilitatorClient` (from
[`@chainsafe/x402-client`](../x402-client)) is re-exported for consumers that drive
`verify`/`settle` themselves:

```ts
import { FacilitatorClient } from "@chainsafe/x402-server-sdk";
const facilitator = new FacilitatorClient("https://x402.example.com", { apiKey: "…" });
const result = await facilitator.settle(payload, requirements);
```
