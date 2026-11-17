---
"@chainsafe/x402-core": major
---

**Breaking. A payment to a party with no `TransferPreapproval` is now refused.**

If your `payTo` party has no preapproval, Canton Coin does not pay it directly:
the Token Standard turns the transfer into an offer the party must accept
before the funds are its own. Until now those payments verified. They are now
refused with `invalid_exact_canton_preapproval_missing` and
`extensions.detail: "no_direct_delivery"`.

**What to do:** make sure every `payTo` party holds a live `TransferPreapproval`
before upgrading. A merchant running its own validator already has one; a party
that only ever received offers does not.

**Why:** a payment that lands in an offer is not a payment. The merchant has
released the resource, the funds sit where the payer can still withdraw them,
and nothing in the signed transfer's arguments says which of the two happened —
only the transaction's consequence nodes do. This is the case the rule exists
for, and it is the one that costs a merchant real money.

### What else is checked

The delivery node must now also be what it claims. Both arms require the
exercised contract to be disclosed by the transaction and, for a registry
token, signed by the instrument's admin — otherwise a payer could append a node
that merely *names* a delivery choice and carry a pending tree past the check
above. The Canton Coin send's own amount is held to the root's, so a dust send
against a correctly bound preapproval no longer passes. A tree carrying a
delivery node of the other arm is refused. The legacy
`TransferPreapproval_Send` is refused, since its argument layout is unmeasured
and its amount therefore cannot be bound.

Separately, a contract the **sender** signs must be co-signed by the
instrument's admin. Such a contract carries the payer's authority into whatever
choices it offers, exercised later by whoever controls them. Only sender-signed
creates are constrained; every create in every real capture satisfies it.

`DecodedTransfer` gains `consequences` (every exercise below the root, with the
disclosed contract it targets, the transfer it names in its own argument, and
that argument's scalar leaves) and `creates` (every contract the transaction
makes). Nothing under a rollback is reported.

### Severity of the rest

Apart from the preapproval case above, these refusals are **verify-passes /
settle-fails**: the forged tree does not execute. Measured, not assumed — a real
prepared transaction, tampered and re-signed with the payer's own key, was
rejected on submission in both shapes tried, against Splice 0.6.0 / Canton 3.4
LocalNet, with an untampered control committing. They matter to a caller that
verifies without settling, which is the Express default: it serves a resource on
`isValid: true` and never learns the payment could not land.

**Not closed:** a consequence of neither arm. Closing it needs a whole-tree
allowlist, which is fail-closed and version-coupled — the day Splice adds a
consequence to the transfer body, every caller refuses honest payments. It is
left to the ledger, which was measured refusing that shape.
