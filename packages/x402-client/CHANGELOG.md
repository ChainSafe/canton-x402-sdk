# @chainsafe/x402-client

## 1.0.0

### Major Changes

- 1a6b930: **Follows the facilitator API of the [x402 v2 specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md).** Breaking: `verify`, `settle` and `supported` send and return the spec's shapes from `@chainsafe/x402-core` 1.0. Requires Node 22.2 or later.

  - `supported()` caches its answer for `supportedTtlMs` (default 5 minutes); `supported({ refresh: true })` bypasses the cache.
  - The `VERSION` export, which always read `0.0.1`, is removed.

### Patch Changes

- Updated dependencies [1a6b930]
  - @chainsafe/x402-core@1.0.0

## 0.1.1

### Patch Changes

- 28c4a67: Fix the release pipeline so all packages publish. `changeset publish` ran each package's `prepack: tsup` in parallel, and a dependent's type-declaration build could read a sibling's `dist` while that sibling was mid-rebuild, failing to publish `x402-express` and `x402-server-sdk`. The `prepack` hook is removed; the single topological `pnpm build` in CI is now the authoritative build and publish ships those artifacts. No runtime or API change.
- Updated dependencies [28c4a67]
  - @chainsafe/x402-core@0.1.1

## 0.1.0

### Minor Changes

- aec5534: First public release on npm.

### Patch Changes

- Updated dependencies [aec5534]
  - @chainsafe/x402-core@0.1.0
