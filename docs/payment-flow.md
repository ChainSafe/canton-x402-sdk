---
description: Every paid request, from the 402 to the on-ledger update id — and which half of it the SDK does for you.
---

# The payment flow

A paid request end to end under `exact` on Canton — from the `402` your route
returns to the on-ledger update id it settles with. This is what runs
underneath the route you gated in [Getting started](/getting-started), and
[The facilitator](/facilitator) then zooms in on steps 5 and 6. You write
almost none of it: the merchant side (steps 1, 5 and 6) is handled via
[`@chainsafe/x402-express`](https://www.npmjs.com/package/@chainsafe/x402-express),
and the payer side (steps 2–4) via the payer's own SDK,
[`@chainsafe/x402-server-sdk`](https://www.npmjs.com/package/@chainsafe/x402-server-sdk).
You configure two things yourself: your route's price and terms in the
`x402-express` middleware (step 1), and the max header size on your resource
server (step 4).

1. **Client hits a gated route (402)**

   Your route answers `402 Payment Required` with the spec's `PaymentRequired`,
   `{ x402Version: 2, resource, accepts: [...] }`, base64-encoded in the
   `PAYMENT-REQUIRED` header and as the body. `resource` names what is being
   paid for: the request URL and the route's description. Each `accepts` entry
   carries `scheme`,
   `network`, `amount`, `asset`, `extra.assetTransferMethod`,
   `extra.synchronizerId` (the synchronizer the payer prepares on),
   `extra.instrumentId`, `extra.executeBeforeSeconds` (120 by default, and
   optionally an `extra.memo`), `extra.feePayer` (the facilitator's own party,
   which pays the transfer's traffic fee, when the facilitator advertises one),
   `payTo` (your Canton party) and a `maxTimeoutSeconds` (60 by default).

2. **Payer builds the transfer**

   The payer queries its Amulet holdings and fetches a `TransferFactory` from
   the Splice Token Standard registry for the asset — the validator scan-proxy
   for Amulet.

3. **Prepare and sign**

   The payer calls Canton's `interactive-submission/prepare` to get the
   transaction blob and its hash, then Ed25519-signs that hash with its party
   key. Nothing is executed, and the private key never leaves the payer.

4. **Retry with `PAYMENT-SIGNATURE`**

   The payment — the requirements it was built against as `accepted` (the
   `accepts[]` entry the payer chose), and the payload: `assetTransferMethod`,
   `preparedTransaction`, `preparedTxHash`, `signature`, `publicKey`,
   `hashingSchemeVersion` — is JSON-encoded, base64'd into a
   `PAYMENT-SIGNATURE` header, and the request is retried. That header carries
   the prepared transaction, gzipped, with its disclosed contracts. The
   middleware also reads a payment of this shape sent under `X-PAYMENT`, the
   name this SDK used before.

5. **Merchant verifies, then settles**

   Your middleware re-checks the payment against your own terms — scheme,
   network, `payTo`, asset, the synchronizer, the fee payer,
   `maxTimeoutSeconds`, and that it is
   neither underpriced nor expired — using the exact requirements the payment was built against, its
   `accepted`, which the facilitator then holds the signed transfer to, so a
   payment built for other terms can't pass. It then POSTs
   `{ x402Version, paymentPayload, paymentRequirements }` to `/v2/verify` and,
   with `settle: true` (the default is `false`: verify only), to `/v2/settle`,
   with your API key. A payment that fails your terms or the facilitator's
   verify gets a fresh challenge (a new `402`) instead of being settled.

6. **Facilitator executes on Canton**

   `/v2/settle` re-runs [every verify check](/facilitator#what-verify-guarantees),
   then calls Canton's `executeAndWaitForTransaction` with the payer-signed
   blob. On success it returns the update id as `transaction`, which the
   middleware puts on your response as `X-PAYMENT-RESPONSE`, and your handler
   runs with the verified payer on `req.x402`.

::: danger Raise your server's max header size
The `PAYMENT-SIGNATURE` header from step 4 runs to about 10 KB for a typical
transfer — much of Node's ~16 KB default, which covers all of a request's
headers together — so a Node/Express merchant server should set
`maxHeaderSize` (e.g. `--max-http-header-size`) or the paid retry dies with
`431 Request Header Fields Too Large` before your handler ever runs. Step 6 of
[Getting started](/getting-started#wire-up-your-server) shows where it goes.
The scheme spec asks every server and proxy on the way to accept at least
16 KiB for this header. A proxy in front needs it too: nginx's default
`large_client_header_buffers 4 8k` refuses any single header over 8 KiB.
:::
