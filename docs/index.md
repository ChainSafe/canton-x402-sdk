---
description: What the facilitator does, why it is non-custodial, the scheme it implements, and where your API key fits.
---

# The x402 facilitator

`x402` makes an ordinary HTTP request payable: a client that calls a paid
endpoint gets back `402 Payment Required`, signs a payment, and retries with
it. The **facilitator** is the HTTP service that turns that signed payment into
a real, settled payment on the Canton Network — so your server never has to
speak to a ledger, hold a wallet, or run a node. Your server (the resource
server) just hands each payment to the facilitator, which does exactly two
things with it: `POST /v2/verify` checks a signed payment against your terms
without submitting or reserving anything; `POST /v2/settle` then executes it on
Canton and returns the update id.

## Non-custodial by construction

Canton settles in three steps — `prepare`, `sign`, `execute` — and that split
is what makes the facilitator non-custodial. The payer does `prepare` and
`sign` with its own key, without going through the facilitator. The
facilitator only ever performs the final `execute` of a transaction the payer
already signed: it never sees a private key, and it cannot move funds without
that signature.

## The payment scheme

- `exact-canton` — the payer transfers Canton Coin (Amulet) directly to your
  party; you receive CC.

[`GET /v2/supported`](/api-reference#get-v2-supported) is the authority on
what a given facilitator accepts — the network id and the asset to pay in.

## How you get paid

Settlements land directly at your **Canton party** — the payout party of the
project your API key belongs to. The payer transfers Amulet (CC) straight to
it; the facilitator holds no balance, so there is nothing to withdraw. That
relies on your payout party having a `TransferPreapproval`: to a party without
one, Amulet delivers each payment as a transfer offer that the party has to
accept before the CC is its own (see
[What settlement does](/facilitator#what-settlement-does)). Completed
settlements show up on the Settlements page of the merchant dashboard.

## Your API key is the facilitator credential

A key you create on the API keys page of the merchant dashboard is what your
server sends as `Authorization: Bearer` to `/v2/verify` and `/v2/settle`. You
can create and rotate keys in the dashboard yourself — no facilitator redeploy
— and the key itself is never stored: what is kept is its hash, plus its
`sk_live_`/`sk_test_` prefix and last four characters so you can tell your keys
apart. A revocation can take up to a
couple of minutes to take effect.

::: tip Next
[Getting started](/getting-started) takes you from a fresh account to a paid
endpoint.
:::
