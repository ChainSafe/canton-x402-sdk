# @chainsafe/x402-core

Shared core for the Canton [x402](https://x402.org) SDK: wire types, canonical
`PaymentRequirements` hashing, verify primitives, and network presets. Every
other `@chainsafe/x402-*` package builds on this one.

Ships dual ESM + CJS with type declarations. Its runtime dependencies
(`valibot`, `@noble/*`, `protobufjs`) are **bundled**, so it installs with no
external runtime dependencies.

## Install

```bash
npm install @chainsafe/x402-core
```

## What's in it

- **Wire types** for the exact-canton x402 scheme — `CantonPaymentPayload`,
  `CantonPaymentRequirements`, and the verify / settle / supported request and
  response shapes (validated with [valibot](https://valibot.dev)).
- **`requirementsHash()`** — the canonical hash that binds a payment to its
  `PaymentRequirements`.
- **Verify primitives** — `createExactCantonVerifier()` plus Ed25519 signature
  and party-fingerprint helpers.
- **Network presets & guards** — devnet/mainnet ids and validators such as
  `isX402Request` / `isCantonPaymentRequirements`.

Consumed by [`@chainsafe/x402-client`](../x402-client),
[`@chainsafe/x402-express`](../x402-express), and
[`@chainsafe/x402-server-sdk`](../x402-server-sdk).

## License

Apache-2.0
