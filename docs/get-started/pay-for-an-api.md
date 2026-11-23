---
description: Pay for a gated endpoint from your own service, with a Canton party key and a wrapped fetch.
---

# Pay for an API

If your service is the one _calling_ a paid API, you pay from the other side
with `@chainsafe/x402-server-sdk`. Given your Canton party key and a wallet-sdk
ledger connection, it prepares and Ed25519-signs a Canton Coin transfer and
wraps `fetch` so a `402` is paid and the request retried transparently — you
call the URL and get the paid response back.

## Before you start

- A **funded payer party** — its `partyId` and Ed25519 signing key
  (`privateKey`, the 32-byte seed; the public half is published on the ledger,
  which is where a facilitator reads it), holding enough Canton Coin to cover
  the price.
- A connection to your **participant's Ledger API** — its URL plus OAuth2
  client credentials (LocalNet uses a self-signed token instead).
- The **Amulet Token Standard registry** URL — your validator's scan-proxy for
  Amulet, where the payer fetches the `TransferFactory`.
- The **facilitator** the API you are paying uses — the DevNet and MainNet
  facilitators are listed on [Networks](/get-started/networks).
- The **DSO party** (the Amulet asset admin) — from
  `extra.instruments[].instrumentId.admin` in
  `GET $FACILITATOR_URL/v2/supported` on the facilitator the API you are paying
  uses.

## Steps

1. **Install the payer SDK**

   The payer SDK and the Canton wallet-sdk it signs with.

   ```bash
   npm install @chainsafe/x402-server-sdk @canton-network/wallet-sdk
   ```

2. **Connect and build the payer**

   Pick the network preset (`devnetConfig`, `mainnetConfig`, or
   `localnetConfig`), open a wallet-sdk connection with `SDK.create()`, then
   construct a `CantonX402Payer` from your party key and the Amulet registry.
   The payer only pays requirements on its own `network`, so that must be the
   `network` that `GET $FACILITATOR_URL/v2/supported` returns; pass
   `network` to the preset to override its default.

3. **Wrap fetch and call the endpoint**

   `createX402Fetch(payer)` returns a `fetch` that pays `402`s for you. Call
   the gated URL through it and read the paid response — no 402 handling in
   your own code.

## Putting it together

<<< @/snippets/pay-with-fetch.ts#snippet

The [`examples/mortgage`](https://github.com/ChainSafe/canton-x402-sdk/tree/main/examples/mortgage)
pair in the SDK repo is a full runnable payer + merchant, with the complete
credential wiring in its `.env.example`.

::: tip Next
[Paying from your service](/guides/paying-from-your-service) covers auth on each
network, several payers, and writing your own, and
[Pending settlements](/guides/pending-settlements) what to do when a payment's
outcome is not known yet.
:::
