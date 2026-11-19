---
"@chainsafe/x402-core": major
---

**Breaking.** A canton-exact transfer must now be exercised through a real
transfer factory. The payer chooses which contract to exercise, and until now
nothing looked at that choice — a transfer exercised on a contract the payer
wrote themselves, exposing a choice named `TransferFactory_Transfer` with
arguments shaped like the real one, passed every check the verifier made. The
whole payment reduces to "something called transfer happened", so the rule
fixes what it happened on.

The exercised contract id is resolved against the transaction's own disclosed
input contracts, and the contract it names must be:

- disclosed exactly once, under a package name, module and entity its own
  disclosure and the exercise agree on (`factory_unresolved` otherwise —
  including when nothing discloses it);
- exercised through the Token Standard `TransferFactory` interface
  (`factory_interface`).

Both refuse as `invalid_exact_canton_malformed_payload`, with the cause in
`extensions.detail`.

**`expectedAdmin` is held to the instrument's admin.** The choice argument is
`{ expectedAdmin, transfer }`. The two name different things — `expectedAdmin`
is the FACTORY's admin, which the Token Standard has the factory validate
against its own, while `instrumentId.admin` is the registry administering the
INSTRUMENT — and the standard does not require them equal.

This requires it. `TransferFactoryView.admin` is "the party representing the
registry app that administers the instruments for which this transfer factory
can be used", so a well-formed registry has one party in both, and the real
Canton Coin payment does — and it is what the standard itself asks for: the
factory MUST validate `expectedAdmin` against its own admin, so holding it to
the instrument's admin here puts the ledger at the end of the chain.

What it buys: `expectedAdmin` is what the ledger guards on, so a facilitator
that pins the admin to the real DSO pins the guarded field with it, and a
transfer aimed at another issuer's factory is refused at verify rather than at
execution — which matters most to a caller that verifies without settling.

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

**Who signed the factory is NOT checked.** The Token Standard constrains it
nowhere — `TransferFactory` is an interface and signatories are an
implementation's own choice — and real MainNet bytes differ: Canton Coin's
factory is signed by the DSO, while a Utility Registry transfer exercises the
MERCHANT's own preapproval, signed by the merchant and not the issuer at all.
An earlier draft required the admin among the signatories and refused every
registry payment.

What ties the factory to the issuer instead is `expectedAdmin`, which the
standard requires the factory to validate against its own admin. That link is
the ledger's to enforce, and holds only because vetted packages implement the
MUST; it cannot be checked from the bytes, so nothing here tries.

**What this does not establish — two gaps, both real.**

The disclosure is payer-written: `input_contracts` is part of the blob the payer
signs, so every field this reads is one the payer chose — the interface the
choice was inherited from included. What makes the check bite is not this layer
but the synchronizer,
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

`DecodedTransfer` gains `exercisedContract` — the resolved contract id, the
disclosure's signatories and the interface the choice was inherited from, or
`undefined` when the exercise does not resolve to exactly one agreeing
disclosure. Verification reads only the interface; the contract id and the
signatories are there for a caller that can check them against a registry,
which this layer cannot.
