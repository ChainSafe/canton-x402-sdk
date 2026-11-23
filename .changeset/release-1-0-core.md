---
"@chainsafe/x402-core": major
---

**Implements the [x402 v2 specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md) and the [Canton `exact` scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_canton.md).** Most of this release is breaking because it adopts the specs' wire format: 0.x requirements, payments and facilitator answers are not compatible with 1.0. Requires Node 22.2 or later.

- **Payment requirements** take the spec's shape. `amount` is atomic units (10 decimals, so 0.05 is `"500000000"`), `maxTimeoutSeconds` is required, and `extra` carries `assetTransferMethod`, `instrumentId`, `synchronizerId`, `feePayer`, `executeBeforeSeconds` and an optional `memo`. The scheme is `exact` on `canton:mainnet`, `canton:testnet`, `canton:devnet` or `canton:localnet`.
- **The payment** is the spec's `PaymentPayload`: the chosen requirements in `accepted`, and a gzipped prepared transaction, its hash and the payer's signature. The payer's public key is no longer sent: a facilitator reads it from the ledger and calls `verify(payload, requirements, { payerPublicKeys })`.
- **Verification** enforces the scheme's rules: the recomputed transaction hash, a single `TransferFactory` transfer from the payer's own holdings, delivery through the payee's `TransferPreapproval`, and the quoted deadline and memo.
- **Errors** use the spec's reason codes, with the cause in `extensions.detail`.
- **Facilitator answers** to verify, settle and `/v2/supported` have the spec's shape, and `settlement_pending` is not a failure (`isSettlementPending`).
- **New helpers**: header codecs for `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE`, `/v2/supported` readers (`selectCantonDeployments`), and amount conversion (`ledgerToAtomic`, `atomicToLedger`).
- **The public API** is a deliberate list, recorded in `api-surface.txt`. Validate with the `is*` guards; the schemas and `parse*` functions are no longer exported.
