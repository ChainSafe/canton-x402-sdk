---
description: Link your payout party, create an API key, gate an Express route, and take your first payment.
---

# Accept payments

This takes a merchant from a fresh account to a live, paid endpoint: link the
Canton party that gets paid, create an API key, gate an Express route with
`@chainsafe/x402-express`, and take your first payment. The facilitator does
the on-ledger work — you write a few lines of middleware.
[The facilitator](/concepts/facilitator) explains what it is; this page is the
hands-on part. Building the paying side instead? See
[Pay for an API](/get-started/pay-for-an-api).

## Before you start

- A **Canton party** to receive payouts — you link it in step 1, and it
  becomes your payout party.
- A **Node.js + Express** server — the API you want to charge for.
- Your facilitator's base URL, `FACILITATOR_URL` — the DevNet and MainNet
  facilitators are listed on [Networks](/get-started/networks). The
  integration panel on the merchant dashboard's **API keys** page shows it, with
  the other values the server below reads, as a `.env` you can copy.

## Set up your account

1. **Sign in and link your payout party**

   Sign in to the merchant dashboard with your Canton key. If you signed in
   another way, link a Canton key on the dashboard's **Account** page. The
   key's party is your `payTo`: the payer transfers Canton Coin straight to it,
   and the facilitator holds no balance. A direct transfer needs a
   `TransferPreapproval` on the party — see [How you get paid](/concepts/facilitator#how-you-get-paid).

2. **Create an API key**

   On the merchant dashboard's **API keys** page, create a key. It is shown
   once — copy it now. Your server sends it as `Authorization: Bearer` to the
   facilitator on every verify and settle. The full key is never stored —
   [Your API key is the facilitator credential](/concepts/facilitator#your-api-key-is-the-facilitator-credential)
   covers what is kept, rotation, and revocation.

## Wire up your server

3. **Install the SDK**

   Three packages: the Express middleware, the facilitator client it calls,
   and the shared types and helpers.

   ```bash
   npm install @chainsafe/x402-express @chainsafe/x402-client @chainsafe/x402-core
   ```

4. **Know what your facilitator settles (you do not have to configure it)**

   `GET $FACILITATOR_URL/v2/supported` says what a deployment settles: the
   `network` id, and in `kinds[].extra` the synchronizer it submits to, the
   party that relays your payments (`feePayer`), and the instruments it
   validates, each with the registry party that admins it.

   The middleware reads this for you. Name the instrument by id — `asset:
"Amulet"` — and the rest comes from the facilitator: the synchronizer, the
   party that relays your payments, and the registry party they are validated
   against. These are the facilitator's own facts, so you cannot configure
   them: a wrong one would only fail at verify, after the payer had signed.
   It is fetched once and cached (see `supportedTtlMs` on `FacilitatorClient`),
   not per request.

   `asset` itself is required on every way to pay: `amount` is atomic units of
   something, so each entry says what. `network` is optional: leave it out and
   it is discovered, or name it to choose. If the facilitator settles that
   instrument on more than one network, naming one is required rather than
   guessed. Every field
   is described on [Facilitator APIs](/reference/http-api#get-v2-supported).

5. **Gate a route**

   Point a `FacilitatorClient` at the facilitator with your API key, then wrap
   the route you want to charge for with `paymentRequired()`. With
   `settle: true` the middleware verifies and settles in one shot; a paid,
   verified request then reaches your handler with the payer on `req.x402`.

6. **Raise your server's max header size**

   The `PAYMENT-SIGNATURE` header runs to about 10 KB for a typical transfer —
   much of Node's ~16 KB default, which covers all of a request's headers
   together — so create the server with a larger `maxHeaderSize`, or a paid
   retry with a few more headers dies with `431 Request Header Fields Too Large`
   before your handler ever runs. A proxy in front needs room for it too:
   nginx's default `large_client_header_buffers 4 8k` refuses any single header
   over 8 KiB.

## Putting it together

<<< @/snippets/gate-express.ts#snippet

Its settings are the integration panel's `.env`: `FACILITATOR_URL`,
`FACILITATOR_API_KEY` and `MERCHANT_PARTY`. `NETWORK_ID` and `AMULET_ADMIN` are
not among them — those come from `/v2/supported`, as step 4 describes.

## Take your first payment

7. **Pay the route and confirm it**

   Call your gated route from a payer wired up with the payer SDK
   ([Pay for an API](/get-started/pay-for-an-api) shows how). Once it settles, the
   payment shows up on the merchant dashboard's **Settlements** page with its
   on-ledger update id.

::: tip Next
[Express middleware](/guides/express-middleware) covers every option: several
ways to pay, memos and `preSettle`, and what each request goes through.
[The payment flow](/concepts/payment-flow) walks a request end to end.
:::
