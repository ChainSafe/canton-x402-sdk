# @chainsafe/x402-server-sdk

## 1.0.0

### Major Changes

- 1a6b930: **Pays requirements of the [Canton `exact` scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_canton.md), over the x402 v2 [HTTP transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md).** Breaking: the payment is the spec's payload, so the merchant must be on `@chainsafe/x402-express` 1.0 or another v2 server. Requires Node 22.2 or later.

  - `createX402Fetch` sends the payment in `PAYMENT-SIGNATURE` instead of `X-PAYMENT`, and reads the offer from the `PAYMENT-REQUIRED` header.
  - A 402 whose `PAYMENT-RESPONSE` is `settlement_pending` (`isSettlementPending`) may still land: don't retry it through `createX402Fetch`, which signs a new payment.
  - `CantonPartyKey` no longer takes `publicKey`: pass `{ partyId, privateKey }`. The facilitator reads the key from the ledger.
  - A custom `X402Payer.authorize` receives the 402's `resource` as a second argument (`PaymentContext`).
  - The `VERSION` export, which always read `0.0.1`, is removed.

### Patch Changes

- Updated dependencies [1a6b930]
- Updated dependencies [1a6b930]
  - @chainsafe/x402-client@1.0.0
  - @chainsafe/x402-core@1.0.0

## 0.1.2

### Patch Changes

- ecd453d: Require `@canton-network/wallet-sdk` ^1.6.0, so the ACS read the payer makes
  sends the request body Canton 3.6 accepts.
- 716b9e0: docs: refresh the x402-server-sdk README

## 0.1.1

### Patch Changes

- 28c4a67: Fix the release pipeline so all packages publish. `changeset publish` ran each package's `prepack: tsup` in parallel, and a dependent's type-declaration build could read a sibling's `dist` while that sibling was mid-rebuild, failing to publish `x402-express` and `x402-server-sdk`. The `prepack` hook is removed; the single topological `pnpm build` in CI is now the authoritative build and publish ships those artifacts. No runtime or API change.
- Updated dependencies [28c4a67]
  - @chainsafe/x402-core@0.1.1
  - @chainsafe/x402-client@0.1.1

## 0.1.0

### Minor Changes

- aec5534: First public release on npm.

### Patch Changes

- Updated dependencies [aec5534]
- Updated dependencies [aec5534]
  - @chainsafe/x402-client@0.1.0
  - @chainsafe/x402-core@0.1.0
