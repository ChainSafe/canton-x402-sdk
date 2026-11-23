---
"@chainsafe/x402-client": major
---

**Follows the facilitator API of the [x402 v2 specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md).** Breaking: `verify`, `settle` and `supported` send and return the spec's shapes from `@chainsafe/x402-core` 1.0. Requires Node 22.2 or later.

- `supported()` caches its answer for `supportedTtlMs` (default 5 minutes); `supported({ refresh: true })` bypasses the cache.
- The `VERSION` export, which always read `0.0.1`, is removed.
