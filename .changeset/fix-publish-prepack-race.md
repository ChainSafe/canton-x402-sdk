---
"@chainsafe/x402-core": patch
"@chainsafe/x402-client": patch
"@chainsafe/x402-express": patch
"@chainsafe/x402-server-sdk": patch
---

Fix the release pipeline so all packages publish. `changeset publish` ran each package's `prepack: tsup` in parallel, and a dependent's type-declaration build could read a sibling's `dist` while that sibling was mid-rebuild, failing to publish `x402-express` and `x402-server-sdk`. The `prepack` hook is removed; the single topological `pnpm build` in CI is now the authoritative build and publish ships those artifacts. No runtime or API change.
