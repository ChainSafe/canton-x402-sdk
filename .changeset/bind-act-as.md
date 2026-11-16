---
"@chainsafe/x402-core": major
---

**Breaking.** A prepared transaction must submit as the sender, and as nobody
else.

`Metadata.submitter_info.act_as` names the parties a submission acts for. It is
inside the signing preimage — the hasher concatenates it first — so the payer
chooses it and commits to it. Nothing read it. Nothing in the choice argument
constrains it either, so a transfer that moved the sender's own money could
name any party at all as a co-submitter: a stranger, or a facilitator's own
party.

It is refused now unless it is exactly the transfer's sender. An empty list is
refused with it: that is not "no claim", it is a submission with no proven
submitter.

**Why it mattered.** `act_as` grants AUTHORITY rather than describing the
transfer, so none of the checks that bind the transfer could catch it. Verify
answered valid and the ledger then refused the submission, because the
facilitator relays only the payer's signature and an unsigned co-submitter is
unauthorised — a payment the merchant was told was good, in the window between
verify and settle, free and repeatable. Where a named party is one the
submitting participant already holds act-as rights over, the submission may
carry authority nobody inspected instead of failing.

Refused in the decoder rather than the verifier, as `expectedAdmin` is: two
signed fields that have to agree is a statement about the blob alone, with no
requirements involved. `DecodedTransfer` is unchanged — the parties are read
and checked, not reported.

Every real MainNet capture available carries exactly one `act_as`, equal to the
transfer's sender, Canton Coin and registry tokens alike. The reference
implementation holds the same invariant on every value-moving path, with its
own empty-list guard added after an empty list once skipped the check silently.
