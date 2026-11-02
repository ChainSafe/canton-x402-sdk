# @chainsafe/x402-server-sdk

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
