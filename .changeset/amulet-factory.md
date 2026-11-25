---
"@chainsafe/x402-core": minor
---

Verify now holds a Canton Coin transfer's factory to the one spec Rule 3 names:
the DSO's `ExternalPartyAmuletRules`.

The exercised contract must be a
`Splice.ExternalPartyAmuletRules:ExternalPartyAmuletRules` signed by the
instrument's admin alone. Otherwise verify answers
`invalid_exact_canton_malformed_payload` with:

- `factory_not_amulet_rules`: the transfer exercises another template, even one
  exposing the Token Standard `TransferFactory` interface.
- `factory_signatories`: the contract is signed by someone other than the
  instrument's admin, or by it and someone else.

It always runs for Canton Coin: nothing about it is configured, and
`registryParties` neither turns it on nor off. A real Canton Coin payment meets
it already, since Splice's template is signed by the DSO alone. The registry
token check is unchanged.
