---
description: Link your payout party, create an API key, gate an Express route, and take your first payment.
---

# Getting started

This takes a merchant from a fresh account to a live, paid endpoint: link the
Canton party that gets paid, create an API key, gate an Express route with
`@chainsafe/x402-express`, and take your first payment. The facilitator does
the on-ledger work — you write a few lines of middleware. [The overview](/)
explains what the facilitator is; this page is the hands-on part. Building the
paying side instead? Skip to [the buyer side](#the-buyer-side) below.

## The merchant side: gating an endpoint {#the-merchant-side}

### Before you start

- A **Canton party** to receive payouts — you link it in step 1, and it
  becomes your payout party.
- A **Node.js + Express** server — the API you want to charge for.
- Your facilitator's base URL, `FACILITATOR_URL`. The integration panel on the
  merchant dashboard's **API keys** page shows it, with the other values the
  server below reads, as a `.env` you can copy.

### Set up your account

1. **Sign in and link your payout party**

   Sign in to the merchant dashboard with your Canton key. If you signed in
   another way, link a Canton key on the dashboard's **Account** page. The
   key's party is your `payTo`: the payer transfers Canton Coin straight to it,
   and the facilitator holds no balance. A direct transfer needs a
   `TransferPreapproval` on the party — see [How you get paid](/#how-you-get-paid).

2. **Create an API key**

   On the merchant dashboard's **API keys** page, create a key. It is shown
   once — copy it now. Your server sends it as `Authorization: Bearer` to the
   facilitator on every verify and settle. The full key is never stored —
   [Your API key is the facilitator credential](/#your-api-key-is-the-facilitator-credential)
   covers what is kept, rotation, and revocation.

### Wire up your server

3. **Install the SDK**

   Three packages: the Express middleware, the facilitator client it calls,
   and the shared types and helpers.

   ```bash
   npm install @chainsafe/x402-express @chainsafe/x402-client @chainsafe/x402-core
   ```

4. **Find your network and asset**

   Call `GET $FACILITATOR_URL/v2/supported` once — the `exact-canton` entry
   in its `kinds` array carries the `network` id this facilitator settles on
   and `extra.asset.instrumentId.admin`, the DSO party that admins Amulet. You
   pass both to the middleware below. The integration panel already has them,
   as `NETWORK_ID` and `AMULET_ADMIN`. The
   [API reference](/api-reference#get-v2-supported) describes every field.

5. **Gate a route**

   Point a `FacilitatorClient` at the facilitator with your API key, then wrap
   the route you want to charge for with `paymentRequired()`. With
   `settle: true` the middleware verifies and settles in one shot; a paid,
   verified request then reaches your handler with the payer on `req.x402`.

6. **Raise your server's max header size**

   The `X-PAYMENT` header runs to tens of KB — past Node's ~16 KB default — so
   create the server with a larger `maxHeaderSize`, or the paid retry dies
   with `431 Request Header Fields Too Large` before your handler ever runs.

### Putting it together

<<< @/snippets/gate-express.ts#snippet

Its settings are the integration panel's `.env`: `FACILITATOR_URL`,
`FACILITATOR_API_KEY`, `NETWORK_ID`, `MERCHANT_PARTY` and `AMULET_ADMIN`.

### Take your first payment

7. **Pay the route and confirm it**

   Call your gated route from a payer wired up with the payer SDK
   ([the buyer side](#the-buyer-side) below shows how). Once it settles, the
   payment shows up on the merchant dashboard's **Settlements** page with its
   on-ledger update id.

## The buyer side: paying for one {#the-buyer-side}

If your service is the one _calling_ a paid API, you pay from the other side
with `@chainsafe/x402-server-sdk`. Given your Canton party key and a wallet-sdk
ledger connection, it prepares and Ed25519-signs a Canton Coin transfer and
wraps `fetch` so a `402` is paid and the request retried transparently — you
call the URL and get the paid response back.

### Before you start

- A **funded payer party** — its `partyId` and Ed25519 keypair (`publicKey` /
  `privateKey`), holding enough Canton Coin to cover the price.
- A connection to your **participant's Ledger API** — its URL plus OAuth2
  client credentials (LocalNet uses a self-signed token instead).
- The **Amulet Token Standard registry** URL — your validator's scan-proxy for
  Amulet, where the payer fetches the `TransferFactory`.
- The **DSO party** (the Amulet asset admin) — `extra.asset.instrumentId.admin`
  from `GET $FACILITATOR_URL/v2/supported` on the facilitator the API you
  are paying uses.

### Steps

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

### Putting it together

<<< @/snippets/pay-with-fetch.ts#snippet

The [`examples/mortgage`](https://github.com/ChainSafe/canton-x402-sdk/tree/main/examples/mortgage)
pair in the SDK repo is a full runnable payer + merchant, with the complete
credential wiring in its `.env.example`.

::: tip Next
[The payment flow](/payment-flow) walks every request end to end, and the
[API reference](/api-reference) has the full request and response spec for
`/v2/verify` and `/v2/settle`.
:::
