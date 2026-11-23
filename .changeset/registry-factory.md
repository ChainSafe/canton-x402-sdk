---
"@chainsafe/x402-core": minor
---

Verify can now hold a registry token's transfer factory to the one spec Rule 3
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
