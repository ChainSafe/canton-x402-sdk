---
"@chainsafe/x402-core": minor
---

A canton-exact transfer must now be exercised through a real transfer factory.
The payer chooses which contract to exercise, and until now nothing looked at
that choice — a transfer exercised on a contract the payer wrote themselves,
exposing a choice named `TransferFactory_Transfer` with arguments shaped like
the real one, passed every check the verifier made. The whole payment reduces
to "something called transfer happened", so the rule fixes what it happened on.

The exercised contract id is resolved against the transaction's own disclosed
input contracts, and the contract it names must be:

- disclosed exactly once, under a package name, module and entity its own
  disclosure and the exercise agree on (`factory_unresolved` otherwise —
  including when nothing discloses it);
- exercised through the Token Standard `TransferFactory` interface
  (`factory_interface`);
- signed by the admin the instrument names (`factory_signatory`).

All three refuse as `invalid_exact_canton_malformed_payload` /
`transfer_mismatch`.

**The interface, not the template.** `TransferFactory_Transfer` is defined on
`Splice.Api.Token.TransferInstructionV1:TransferFactory`, which each registry
implements with its own template — Canton Coin with `ExternalPartyAmuletRules`,
another issuer with its own. Matching Canton Coin's template would refuse every
other registry's instrument, which this package routes payments to by design.

**No package id is compared**, against either a constant or the other side of
the blob. Canton documents that an exercise's `template_id` and its target
contract's may differ once the contract has been upgraded or downgraded: the
first names the package the choice resolved against, the second the package the
contract was created under. Requiring them equal would refuse honest payments
for the whole window of a Splice rollout. The package NAME is what an upgrade
preserves, so that is what the two sides must agree on.

**The admin is among the signatories, not the only one.** A registry's factory
can legitimately carry more than one party — the reference facilitator keeps a
configured allowlist of registry infrastructure parties for this, noting that a
bridged token's factory names the bridge operator too.

**What this does not establish — two gaps, both real.**

The disclosure is payer-written: `input_contracts` is part of the blob the payer
signs, so every field this reads is one the payer chose, including the
signatory. What makes the check bite is not this layer but the synchronizer,
which authenticates a disclosed contract against its contract id at submission,
so a fabricated disclosure never settles. The proof is self-attested here and
enforced at settlement — a caller that verifies without settling gets no
protection from it.

The admin is read from the payment requirements, which the merchant supplies,
so the rule binds the payer to the merchant's declared issuer rather than to
Canton Coin itself. Pinning the real DSO needs a value only a facilitator holds,
so that check belongs there and is not in this package.

What the rule does buy: a payer cannot swap in a contract of their own that
merely exposes a same-named choice and have it SETTLE, which before this check
it could.

`DecodedTransfer` gains `exercisedContract` — the resolved contract id, package
name, template, signatories and the interface the choice was inherited from, or
`undefined` when the exercise does not resolve to exactly one agreeing
disclosure.
