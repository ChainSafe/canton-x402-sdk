# @chainsafe/x402-express

## 1.0.0

### Major Changes

- 1a6b930: **Speaks the [x402 v2 specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md), its [HTTP transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md) and the [Canton `exact` scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_canton.md).** Breaking: the configuration and the HTTP exchange follow the specs. Requires Node 22.2 or later and a facilitator that implements x402 v2.

  - **Configure ways to pay, not Canton details.** `requirements` takes `accepts`, one entry per instrument, each an instrument id (`"Amulet"`, `"USDCx"`) and an atomic `amount`. The registry admin, synchronizer and fee payer are read from the facilitator's `/v2/supported` and can no longer be set. `additionalAccepts`, `validForSeconds` and `nonce` are removed; use `memo` for an order reference. The middleware doesn't check that a `memo` is one you issued, and nothing makes it single-use: if you reconcile orders on it, check it in `preSettle`.
  - **HTTP headers follow the spec.** The 402 carries `PAYMENT-REQUIRED`, the payment arrives in `PAYMENT-SIGNATURE`, and the settle answer is returned in `PAYMENT-RESPONSE`, which replaces `X-PAYMENT-RESPONSE`.
  - **A pending settlement is never re-challenged**, so a payer retries the same payment instead of paying twice.
  - **Rejections carry the spec's reason codes**, with the cause in `extensions.detail`.
  - **New:** `preSettle` and `onQuoteError` hooks, the `executeBeforeSeconds` and `maxTimeoutSeconds` options, and `SchemeAdapter` for gating a route on another scheme.
  - The `VERSION` export, which always read `0.0.1`, is removed.

  Every `payTo` party needs a `TransferPreapproval`. Expose `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE` and allow `PAYMENT-SIGNATURE` in CORS, and let proxies accept a header of at least 16 KiB.

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

### Patch Changes

- Updated dependencies [1a6b930]
- Updated dependencies [1a6b930]
  - @chainsafe/x402-client@1.0.0
  - @chainsafe/x402-core@1.0.0

## 0.2.0

### Minor Changes

- 067d870: Verify rejections now forward the facilitator's `extensions.detail` as `details` in the 402 body, as settle rejections already did. New opt-in `onReject` option reports every rejected payment (402) and facilitator/middleware failure (502/500), including the facilitator's full `extensions`, so merchants can log why a payment failed.

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
