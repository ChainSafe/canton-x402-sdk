---
description: Move an integration from the 0.x packages to 1.0, which adopts the x402 v2 specification and the Canton exact scheme.
---

# Upgrading to 1.0

1.0 adopts the [x402 v2 specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md),
its [HTTP transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md)
and the [Canton `exact` scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_canton.md).
Most of the changes are breaking because the wire format is the specs' now: a
0.x payer cannot pay a 1.0 merchant, and a 0.x merchant cannot quote for a 1.0
payer.

## Before you start

- **Upgrade both sides together.** Move the merchant and the payers that call it
  to 1.0 at the same time, against a facilitator that speaks x402 v2 (every
  [network](/get-started/networks) does).
- **Node 22.2 or later** for every package.
- **Every `payTo` party needs a live `TransferPreapproval`.** A payment that
  would not land directly is refused (`invalid_exact_canton_preapproval_missing`).

## Merchants: `@chainsafe/x402-express`

Configure ways to pay, not Canton details. Each entry in `accepts` names an
instrument by id and an amount in **atomic units** (10 decimals, so 0.05 CC is
`"500000000"`). The registry admin, the synchronizer and the fee payer come from
the facilitator's `/v2/supported`, and can no longer be set.

```ts
// 0.2.0
paymentRequired({
  facilitator,
  requirements: {
    payTo,
    network: "canton:1220…",
    asset: { instrumentId: { id: "Amulet", admin: "DSO::1220…" } },
    amount: "0.05",
    nonce: (req) => newOrder(req),
  },
});

// 1.0.0
paymentRequired({
  facilitator,
  requirements: {
    payTo,
    memo: (req) => newOrder(req),
    accepts: [{ asset: "Amulet", amount: "500000000" }], // 0.05 CC
  },
});
```

- **`network` is optional.** Leave it out and it is discovered from
  `/v2/supported`. Named, it is a `canton:<name>` such as `canton:mainnet`, no
  longer the `canton:1220…` hash.
- **Removed options:** `asset` as an object, `additionalAccepts`,
  `validForSeconds` and `nonce`. Use `memo` for an order reference, but it is
  not a drop-in for `nonce`: the middleware doesn't check that a `memo` is one
  you issued, and nothing makes it single-use. If you reconcile orders on it,
  check it in `preSettle`.
- **Headers:** the 402 carries `PAYMENT-REQUIRED`, the payment arrives in
  `PAYMENT-SIGNATURE` (`X-PAYMENT` is still read), and the settle answer goes
  back in `PAYMENT-RESPONSE`, which replaces `X-PAYMENT-RESPONSE`.
- **CORS:** expose `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE`, and allow
  `PAYMENT-SIGNATURE`.
- **Header size:** the server and every proxy in front of it must accept a
  header of at least 16 KiB; see
  [Accept payments](/get-started/accept-payments#wire-up-your-server).
- **A pending settlement is never re-challenged,** so a payer retries the same
  payment instead of paying twice.
- **New:** the `preSettle` and `onQuoteError` hooks, the `executeBeforeSeconds`
  and `maxTimeoutSeconds` options, and `SchemeAdapter` for gating a route on
  another scheme.

## Payers: `@chainsafe/x402-server-sdk`

- **No public key.** `CantonPartyKey` is `{ partyId, privateKey }`; drop
  `publicKey`. The facilitator reads the party's key from the ledger.
- **Headers:** `createX402Fetch` sends the payment in `PAYMENT-SIGNATURE`
  instead of `X-PAYMENT`, and reads the offer from the `PAYMENT-REQUIRED`
  header.
- **Don't retry a pending payment.** A 402 whose `PAYMENT-RESPONSE` is
  `settlement_pending` (`isSettlementPending`) may still land. Retrying the
  request through `createX402Fetch` signs a new payment, so the payer could pay
  twice.
- **Custom payers:** `X402Payer.authorize` receives the 402's `resource` as a
  second argument (`PaymentContext`).

## Calling the facilitator: `@chainsafe/x402-client`

- `verify`, `settle` and `supported` send and return the spec's shapes from
  `@chainsafe/x402-core` 1.0.
- **`settlement_pending` is not a failure.** Check it with
  `isSettlementPending`, and retry settle with the same payload to learn the
  outcome.
- `supported()` caches its answer for `supportedTtlMs` (5 minutes by default);
  `supported({ refresh: true })` skips the cache.

## Shared types: `@chainsafe/x402-core`

- **Requirements and payloads** are the spec's `PaymentRequirements` and
  `PaymentPayload`. The scheme is `exact` on `canton:mainnet`,
  `canton:testnet`, `canton:devnet` or `canton:localnet`, and the payload names
  the requirements it was built against in `accepted`.
- **Error codes** are the spec's, with the cause in `extensions.detail`. Codes
  from 0.x no longer parse; see [Error codes](/reference/error-codes).
- **Verifying** a payment yourself takes the payer's keys from the caller:
  `verify(payload, requirements, { payerPublicKeys })`.
- **Validate with the `is*` guards.** Most schemas and `parse*` functions are
  no longer exported.
- **New helpers:** header codecs for `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE`,
  `selectCantonDeployments` for reading `/v2/supported`, and `ledgerToAtomic` /
  `atomicToLedger` for amounts.
- The `VERSION` export, which always read `0.0.1`, is gone from every package.
