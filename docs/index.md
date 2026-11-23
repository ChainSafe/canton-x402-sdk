---
layout: home
description: Pay for an HTTP request on Canton — charge for your API, or pay for someone else's, through the x402 facilitator and the SDK that talks to it.

hero:
  name: Canton x402
  text: Pay for an HTTP request on Canton
  tagline: Charge for your API, or pay for someone else's, in a single HTTP round trip — settled on the Canton Network by a facilitator that never holds your funds.
  actions:
    - theme: brand
      text: Accept payments
      link: /get-started/accept-payments
    - theme: alt
      text: Pay for an API
      link: /get-started/pay-for-an-api

features:
  - title: Accept payments
    details: Gate an Express route with @chainsafe/x402-express. The facilitator verifies and settles each payment, straight to your Canton party.
    link: /get-started/accept-payments
    linkText: Merchant quickstart
  - title: Pay for an API
    details: Wrap fetch with @chainsafe/x402-server-sdk, and a 402 is paid and the request retried for you.
    link: /get-started/pay-for-an-api
    linkText: Buyer quickstart
  - title: How it works
    details: Every paid request from the 402 to the on-ledger update id, and what the facilitator checks before any money moves.
    link: /concepts/payment-flow
    linkText: The payment flow
  - title: Facilitator HTTP API
    details: GET /v2/supported, POST /v2/verify and POST /v2/settle, for calling the facilitator directly.
    link: /reference/http-api
    linkText: HTTP API reference
---

`x402` makes an ordinary HTTP request payable: a client that calls a paid
endpoint gets back `402 Payment Required`, signs a payment, and retries with
it. The **facilitator** is the HTTP service that turns that signed payment into
a real, settled payment on the Canton Network — so your server never has to
speak to a ledger, hold a wallet, or run a node. [The facilitator](/concepts/facilitator)
explains what it does and why it is non-custodial.
