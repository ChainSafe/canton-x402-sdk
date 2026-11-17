---
"@chainsafe/x402-core": major
---

**Breaking.** A canton-exact transfer must DELIVER, the delivery must be the
merchant's, and nothing else in the tree may move value or take the payer's
authority.

The same signed `TransferFactory_Transfer` does one of two things: it pays the
receiver in one step, or it creates a pending `TransferInstruction` the payer
can later withdraw. Which one happened is not in the choice's arguments — only
the transaction's consequence nodes say. Relaying a pending one settles into a
half-done state: the payer's funds committed, the merchant unpaid.

`DecodedTransfer` gains `consequences` (every exercise below the root, with its
choice, template, whether it consumes, the disclosed contract it targets, the
transfer it names in its own argument, and that argument's scalar leaves) and
`creates` (every contract the transaction makes). Nothing under a rollback is
reported; a rolled-back node happened to nobody.

### What each arm requires

**Canton Coin:** exactly one `TransferPreapproval_SendV2` on
`Splice.AmuletRules:TransferPreapproval`, its contract disclosed by this
transaction, that disclosure's `receiver` equal to `payTo` and `dso` equal to
the instrument's admin, its signatories exactly the parties the record names,
and the send's **own amount** equal to the root's.

**A registry token:** exactly one `TransferRule_DirectTransfer`, **anchored to
a disclosed contract the instrument's admin signed**, whose `transfer` record
carries the root's sender, receiver, amount and instrument.

Amounts compare as decimals, so `0.01` and `0.0100000000` are one amount.

### The registry arm was defeatable by a node that cost nothing to type

It read what a node CLAIMED it delivered and never where the node came from. A
genuine pending two-step tree — correctly refused — plus one bare node named
`TransferRule_DirectTransfer`, exercising nothing, carrying a copy of the
root's own transfer record, returned `isValid: true`. That is the only case
here where the answer flips from refuse to accept, and the only one where a
merchant releases goods for money that is parked where the payer can withdraw
it. The Canton Coin arm always required its contract; the registry arm now does
too.

### The arm not chosen still has to be empty

Each arm found its own node, bound it, and returned, never looking at the
other's filter — so a second delivery of the other shape rode along beside a
correctly bound one, moving whatever it liked to whoever it liked. Both
directions verified. Each arm now refuses a tree carrying the other's node.

### The arm is chosen by the instrument, never by the tree

Picking it from what the transaction contains lets a payer select the weaker
rule by writing the node that selects it.

### Signatories are compared as a set, not counted to three

A merchant running its own validator is its own provider, so a stock
preapproval carries two signatories; counting would make such a merchant
permanently unpayable. Only the degenerate case, one party in all three roles,
is refused.

### A contract the sender signs must be co-signed by the issuer

Creates were invisible — the decoder skipped every non-exercise node, so the
`Amulet` that is the merchant's payment and the one that is the payer's change
were both unread. A contract the SENDER signs carries the payer's authority
into whatever choices it offers, exercised later by whoever controls them. Only
sender-signed creates are constrained, and only to co-signature by the
instrument's admin — every create in every real capture satisfies it, 13 of 13.

### The legacy `TransferPreapproval_Send` is refused

It stays in the locator set so the node is found and answered precisely rather
than reported as no delivery at all, but its argument layout is unmeasured, so
binding its amount would mean reading a position nobody checked.

### A record is read the way the engine binds it, here too

`argField` chose label-mode when ANY field carried a label; the engine chooses
it only when EVERY field does. This is the reader that decides whose
preapproval the delivery spends, so a disclosure with one blank label was read
by name while the ledger read it by position. Same correction as `pick`.

### Severity, measured rather than argued

Every refusal here except the registry anchor is a **verify-passes /
settle-fails** case: the forged tree does not execute. That was an inference
until it was run — a real prepared transaction, tampered and re-signed with the
payer's own key, was rejected on submission in both shapes tried (an extra
consequence node, and a create with its issuer stripped), against Splice 0.6.0
/ Canton 3.4 LocalNet. So these checks protect the caller that verifies without
settling — the Express default, which serves a resource on `isValid: true` and
never learns the payment could not land. The registry anchor is the exception:
that tree settles perfectly well and simply does not pay the merchant.

**Not closed:** a consequence of neither arm. See `deliveryFailure`'s note —
left to the ledger, which was measured refusing it, rather than shipping a
fail-closed allowlist that would refuse honest payments on the next Splice
release.

Read from the signed bytes rather than probed against the ledger: these are the
exact bytes to be relayed, so there is no resolve-then-settle window, and a
retried settle whose holdings an earlier one consumed still answers the same.
