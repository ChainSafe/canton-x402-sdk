# @chainsafe/x402-server-sdk

Payer-side SDK for [x402](https://x402.org) on the Canton Network. With a Canton
party's Ed25519 key and ledger access (via [`@canton-network/wallet-sdk`](https://www.npmjs.com/package/@canton-network/wallet-sdk)),
it prepares and signs the transfer an x402 endpoint asks for and returns the
payment a facilitator settles: the payer authorizes, it never executes.
`createX402Fetch` wraps `fetch` so a `402` is paid and the request retried for
you.

For agents, services and backends that hold a party key. Paying from a user's
browser wallet is a different path and out of scope here.

## Install

```bash
npm install @chainsafe/x402-server-sdk @canton-network/wallet-sdk
```

## Usage

```ts
import { SDK } from "@canton-network/wallet-sdk";
import { CantonX402Payer, createX402Fetch, devnetConfig } from "@chainsafe/x402-server-sdk";

const net = devnetConfig({ ledgerClientUrl: "https://<your-participant>/…" });
const sdk = await SDK.create({
  auth,
  ledgerClientUrl: net.ledgerClientUrl,
  token: { auth, registries },
});

const payer = new CantonX402Payer({
  sdk,
  key: { partyId: "payer::1220…", privateKey: "<base64 seed>" },
  network: net.network,
  registries: [
    { instrumentId: { id: "Amulet", admin: "DSO::1220…" }, registryUrl: amuletRegistry },
  ],
});

const paidFetch = createX402Fetch(payer);
const res = await paidFetch("https://api.example/paid"); // 402 → pay → retry
```

## Documentation

- [Pay for an API](https://chainsafe.github.io/canton-x402-sdk/get-started/pay-for-an-api.html): the quickstart
- [Paying from your service](https://chainsafe.github.io/canton-x402-sdk/guides/paying-from-your-service.html): auth on each network, the payer, the auto-pay fetch, and writing your own payer
- [Pending settlements](https://chainsafe.github.io/canton-x402-sdk/guides/pending-settlements.html): why a `settlement_pending` answer must not be retried through `createX402Fetch`

## License

Apache-2.0
