---
layout: home
description: Pay for an HTTP request on Canton — charge for your API, or pay for someone else's, through the x402 facilitator and the SDK that talks to it.

hero:
  name: x402 on Canton
  text: Pay for an HTTP request on Canton
  tagline: Charge for your API, or pay for someone else's, in a single HTTP round trip — settled on the Canton Network by a facilitator that never holds your funds.
  actions:
    - theme: brand
      text: Accept payments
      link: /get-started/accept-payments
    - theme: alt
      text: Pay for an API
      link: /get-started/pay-for-an-api
    - theme: alt
      text: View on GitHub
      link: https://github.com/ChainSafe/canton-x402-sdk

features:
  - title: Non-custodial
    details: Payers prepare and sign on their own participant. The facilitator only executes a transaction the payer already signed — it never sees a private key, and never picks the payer's holdings.
    link: /concepts/facilitator#non-custodial-by-construction
    linkText: Why it is non-custodial
  - title: Canton-native
    details: Settlement is a Splice Token Standard transfer through the instrument's TransferFactory, delivered straight to your party through its TransferPreapproval — one atomic Canton transaction.
    link: /concepts/facilitator#what-settlement-does
    linkText: What settlement does
  - title: Standards-aligned
    details: The x402 v2 wire format and the Canton exact scheme — the quote in the 402's PAYMENT-REQUIRED header, the signed payment in PAYMENT-SIGNATURE, verify and settle at the facilitator.
    link: /protocol/spec
    linkText: The protocol
---

`x402` makes an ordinary HTTP request payable: a client that calls a paid
endpoint gets back `402 Payment Required`, signs a payment, and retries with
it. The **facilitator** is the HTTP service that turns that signed payment into
a real, settled payment on the Canton Network — so your server never has to
speak to a ledger, hold a wallet, or run a node. [The facilitator](/concepts/facilitator)
explains what it does and why it is non-custodial.

## Choose your integration path

<IntegrationPaths />

## Payment flow

A paid request is an ordinary HTTP request, retried once. The first try comes
back `402 Payment Required` with the price and terms. The payer prepares a
Canton transfer for exactly that amount, signs it with its own key, and retries
with the signed payment attached. Your server hands it to the facilitator,
which checks that the signed transfer pays exactly your terms, then executes it
on Canton, where the funds land at your party. Custody stays with the payer
throughout: the facilitator never sees a private key, and can only submit the
transaction the payer signed.

<PaymentFlow />

[Each step in detail →](/concepts/payment-flow)

## Browse the docs

- **Get started** — [Accept payments](/get-started/accept-payments) ·
  [Pay for an API](/get-started/pay-for-an-api) ·
  [Networks](/get-started/networks)
- **Guides** — [Express middleware](/guides/express-middleware) ·
  [Paying from your service](/guides/paying-from-your-service) ·
  [Calling the facilitator](/guides/calling-the-facilitator) ·
  [Pending settlements](/guides/pending-settlements) ·
  [Upgrading to 1.0](/guides/upgrading-to-1-0)
- **Concepts** — [The payment flow](/concepts/payment-flow) ·
  [The facilitator](/concepts/facilitator)
- **Reference** — [Facilitator HTTP API](/reference/http-api) ·
  [Error codes](/reference/error-codes) · [Protocol spec](/protocol/spec)
