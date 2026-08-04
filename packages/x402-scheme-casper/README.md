# @chainsafe/x402-scheme-casper

The x402 `exact` scheme on the [Casper Network](https://casper.network) — wire types, network presets, a pure `SchemeVerifier` for `@chainsafe/x402-core`'s registry, and a thin facilitator client.

- **Networks** (CAIP-2): `casper:casper` (MainNet), `casper:casper-test` (TestNet).
- **Settlement asset**: wCSPR, a CEP-18 token on Casper (any CEP-18 contract works via `CasperAssetSpec`).
- **Facilitator**: verify/settle per x402 v2 against a Casper facilitator, e.g. the hosted [`x402-facilitator.cspr.cloud`](https://docs.cspr.cloud) (default).
- **Wire shapes** interoperate with the [`@make-software/casper-x402`](https://github.com/make-software/casper-x402) ecosystem: an EIP-712-style signed CEP-18 `transfer_with_authorization`.

## Usage

```ts
import {
  CASPER_TESTNET_NETWORK,
  CasperFacilitatorClient,
  createExactCasperVerifier,
  wcsprAsset,
} from "@chainsafe/x402-scheme-casper";
import { createVerifierRegistry } from "@chainsafe/x402-core";

// Pure stateless pre-check, pluggable into core's (scheme, network) registry:
const registry = createVerifierRegistry([createExactCasperVerifier(CASPER_TESTNET_NETWORK)]);
const verdict = registry.verify(paymentPayload, paymentRequirements);

// Facilitator verify + settle (x402 v2):
const facilitator = new CasperFacilitatorClient(); // defaults to https://x402-facilitator.cspr.cloud
await facilitator.verify(paymentPayload, paymentRequirements);
await facilitator.settle(paymentPayload, paymentRequirements);
```

The pure verifier runs the stateless checks (scheme/network agreement, shapes, expiry of both the requirements and the signed authorization window, recipient/amount binding, signature well-formedness). Signature recovery against the casper-eip-712 domain, nonce replay, and on-chain execution are the facilitator's job — mirroring how `exact-canton` splits pure vs. stateful.
