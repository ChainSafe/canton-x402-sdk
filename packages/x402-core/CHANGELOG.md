# @chainsafe/x402-core

## 1.1.0

### Minor Changes

- a7c5d69: Verify can now hold a registry token's transfer factory to the one spec Rule 3
  names: the receiver's own registry `TransferPreapproval`.

  It runs on the same switch as the registry parties check: only when the caller
  passes `CantonVerifyContext.registryParties`. Then, for any instrument but
  Canton Coin, the exercised contract must be a
  `Utility.Registry.App.V0.Model.TransferPreapproval` signed by `payTo` alone,
  naming `payTo` as `receiver` and the instrument's admin as `instrumentAdmin`,
  for a registrar with an entry in `registryParties`. Otherwise verify answers
  `invalid_exact_canton_malformed_payload` with:

  - `factory_not_preapproval`: the transfer exercises another factory, such as
    the registry's own, which is what a payee with no preapproval gets. The payee
    has to create one.
  - `factory_signatories`, `factory_receiver` or `factory_admin`: a preapproval,
    but not the receiver's own for this instrument.
  - `factory_registry_unconfigured`: the registrar has no entry. This runs before
    the delivery check, so it is the answer a registrar with no entry gets.

  Leave `registryParties` out and nothing changes, not even the answer for a payee
  with no preapproval. `DecodedTransfer.exercisedContract` gains optional
  `templateId` and `argument`, read the way a consequence's target already is.

- 814bea7: Verify can now be told which registry infrastructure parties to trust for each
  registrar, and then trusts only those (spec Rule 7).

  `CantonVerifyContext` gains an optional `registryParties`: each registrar (an
  instrument's `instrumentId.admin`) mapped to the parties trusted for it. For the
  DA Registry Utility, that is its operator and the token's provider.

  Pass it, and a registry payment (any instrument but Canton Coin) is refused as
  `invalid_exact_canton_preapproval_missing` when it relies on a party that is
  neither the registrar nor listed for it:

  - `delivery_registry_untrusted`: a signatory of the `TransferRule` it delivers
    through, the rule's own `operator` or `provider`, or an input holding's
    `operator` or `provider`. They are compared as a set, not by role.
  - A registrar with no entry is refused too; a map the verifier cannot read
    counts as no entry. The registry factory check (spec Rule 3), which runs
    first, answers it as `invalid_exact_canton_malformed_payload` /
    `factory_registry_unconfigured`. The delivery check's own
    `delivery_registry_unconfigured` stays as a backstop.

  Leave it out and nothing changes: the check does not run, so every existing
  caller verifies exactly as before. Canton Coin ignores it.

## 1.0.0

### Major Changes

- 1a6b930: **Implements the [x402 v2 specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md) and the [Canton `exact` scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_canton.md).** Most of this release is breaking because it adopts the specs' wire format: 0.x requirements, payments and facilitator answers are not compatible with 1.0. Requires Node 22.2 or later.

  - **Payment requirements** take the spec's shape. `amount` is atomic units (10 decimals, so 0.05 is `"500000000"`), `maxTimeoutSeconds` is required, and `extra` carries `assetTransferMethod`, `instrumentId`, `synchronizerId`, `feePayer`, `executeBeforeSeconds` and an optional `memo`. The scheme is `exact` on `canton:mainnet`, `canton:testnet`, `canton:devnet` or `canton:localnet`.
  - **The payment** is the spec's `PaymentPayload`: the chosen requirements in `accepted`, and a gzipped prepared transaction, its hash and the payer's signature. The payer's public key is no longer sent: a facilitator reads it from the ledger and calls `verify(payload, requirements, { payerPublicKeys })`.
  - **Verification** enforces the scheme's rules: the recomputed transaction hash, a single `TransferFactory` transfer from the payer's own holdings, delivery through the payee's `TransferPreapproval`, and the quoted memo.
  - **Errors** use the spec's reason codes, with the cause in `extensions.detail`.
  - **Facilitator answers** to verify, settle and `/v2/supported` have the spec's shape, and `settlement_pending` is not a failure (`isSettlementPending`).
  - **New helpers**: header codecs for `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE`, `/v2/supported` readers (`selectCantonDeployments`), and amount conversion (`ledgerToAtomic`, `atomicToLedger`).
  - **The public API** is a deliberate list, recorded in `api-surface.txt`. Validate with the `is*` guards; most schemas and `parse*` functions are no longer exported.

## 0.1.1

### Patch Changes

- 28c4a67: Fix the release pipeline so all packages publish. `changeset publish` ran each package's `prepack: tsup` in parallel, and a dependent's type-declaration build could read a sibling's `dist` while that sibling was mid-rebuild, failing to publish `x402-express` and `x402-server-sdk`. The `prepack` hook is removed; the single topological `pnpm build` in CI is now the authoritative build and publish ships those artifacts. No runtime or API change.

## 0.1.0

### Minor Changes

- aec5534: First public release on npm.
