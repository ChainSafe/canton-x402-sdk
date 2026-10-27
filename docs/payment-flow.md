---
description: Every paid request, from the 402 to the on-ledger update id — and which half of it the SDK does for you.
---

# The payment flow

A paid request end to end under `exact-canton` — from the `402` your route
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

   Your route answers `402 Payment Required` with
   `{ x402Version: 2, accepts: [...] }`. Each entry carries `scheme`,
   `network`, `maxAmountRequired`, `asset.instrumentId`, `payTo` (your Canton
   party), `resource`, a fresh `nonce`, and a `validBefore` (300 seconds out by
   default).

2. **Payer builds the transfer**

   The payer queries its Amulet holdings and fetches a `TransferFactory` from
   the Splice Token Standard registry for the asset — the validator scan-proxy
   for Amulet.

3. **Prepare and sign**

   The payer calls Canton's `interactive-submission/prepare` to get the
   transaction blob and its hash, then Ed25519-signs that hash with its party
   key. Nothing is executed, and the private key never leaves the payer.

4. **Retry with `X-PAYMENT`**

   The payload — `payer`, `preparedTransaction`, `preparedTransactionHash`,
   `partySignature`, `publicKey`, `requirementsHash`, `hashingSchemeVersion` —
   plus the requirements it was built against are JSON-encoded, base64'd into
   an `X-PAYMENT` header, and the request is retried. That header carries the
   prepared transaction and its disclosed contracts.

5. **Merchant verifies, then settles**

   Your middleware re-checks the payment against your own terms — scheme,
   network, `payTo`, resource, asset, and that it is neither underpriced nor
   expired — using the exact requirements the payment was built against,
   which the payload's `requirementsHash` binds, so a payment built for other
   terms can't pass. It then POSTs
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
The `X-PAYMENT` header from step 4 runs to tens of KB — past Node's ~16 KB
default — so a Node/Express merchant server must set `maxHeaderSize` (e.g.
`--max-http-header-size`) or the paid retry dies with
`431 Request Header Fields Too Large` before your handler ever runs. Step 6 of
[Getting started](/getting-started#wire-up-your-server) shows where it goes.
:::
