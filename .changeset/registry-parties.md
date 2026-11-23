---
"@chainsafe/x402-core": minor
---

Verify can now be told which registry infrastructure parties to trust for each
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
- `delivery_registry_unconfigured`: the registrar has no entry. A map the
  verifier cannot read counts as no entry.

Leave it out and nothing changes: the check does not run, so every existing
caller verifies exactly as before. Canton Coin ignores it.
