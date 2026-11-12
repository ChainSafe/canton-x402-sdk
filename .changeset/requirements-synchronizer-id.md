---
"@chainsafe/x402-core": major
"@chainsafe/x402-express": major
"@chainsafe/x402-server-sdk": major
---

**Breaking.** `extra.synchronizerId`, which the Canton scheme spec requires and
we did not send.

```diff
  "extra": {
    "assetTransferMethod": "transfer-factory",
+   "synchronizerId": "global-domain::1220be58c29e",
    "instrumentId": { "id": "Amulet", "admin": "DSO::1220…" },
    "executeBeforeSeconds": 120
  }
```

Scope 6 of #76. The network id stopped carrying the synchronizer when it became
a name, so there was nowhere left for it to travel: a payment landed on
whatever domain the payer's participant happened to prepare against, which need
not be one the merchant settles on.

The payer now prepares against the quoted one, and the verifier pins the
transaction's signed `Metadata.synchronizer_id` to it. That field is inside the
block the signature covers, so it is the payer's commitment rather than a
relay's choice.

A mismatch answers **`invalid_exact_canton_synchronizer_mismatch`**, new in
core, with `transfer_mismatch` in `extensions.reason` and `synchronizer` in the
detail — the shape every other mismatch already uses.

The scheme spec names `extra.synchronizerId` but defines no rule for it and so
no code, so this one is ours. In the scheme's own family rather than borrowed
from the protocol's, for two reasons. `invalidReason` is the slot a client
written against the scheme matches on, and the first cut put `transfer_mismatch`
there — a protocol-level code of ours, which no such client matches and which
`extensions.reason` was already carrying. And the obvious substitute,
`invalid_network`, already answers Rule 1's quoted-network check: one code for
two different failures tells a client less, not more. Two codes we ship are
likewise absent from the spec's text (`execute_before_too_far`,
`merchant_not_registered`, both present in the registered facilitator's own
implementation), so the namespace is already wider than the document. The rule
and the code belong upstream, and that is a separate proposal.

`MISMATCH_REASON` is typed to the scheme's codes alone now
(`SpecVerifyInvalidReason`, new in core) rather than to every code a response
may carry, so reaching for one of our protocol-level codes in that slot is a
build error rather than something to catch in review.

**One thing the pin cannot do on its own.** It runs in the facilitator's
`/verify`, and the scheme spec mandates no synchronizer rule — so against a
conformant facilitator that implements only the spec's thirteen rules, the
signed transfer's domain goes unchecked. The middleware's own
`policy_synchronizer` compares the payer's ECHOED value against the quote, and
both of those are unsigned. The binding is real against a facilitator that
implements this check and advisory against one that does not.

### Logical in, physical out

The part worth reading, because the obvious implementation is wrong.

`prepare` takes the **logical** id, `global-domain::1220<fingerprint>`, and
refuses the physical one — yet the bytes it returns carry the physical form:
the logical id plus a participant-chosen `::<protocol-version>-<topology-serial>`.

```
quoted:  global-domain::1220be58c29e
signed:  global-domain::1220be58c29e::35-2
```

So the merchant quotes the logical id and the pin accepts either it exactly, or
it followed by a strict `::<n>-<m>`. That is not a weakening: the `1220…` is the
domain's namespace fingerprint, so `<quoted>::<n>-<m>` is provably the same
domain at another version and serial. Another name, another fingerprint, a
non-numeric or three-part suffix, or any trailing text is refused, and a
transfer naming no synchronizer counts as a mismatch.

An exact-equality pin would have refused every honest payment. The mutation
that reduces the rule to equality fails the test that covers it.

### Where the value comes from

`GET /v2/supported` already advertises it, as `extra.synchronizerId` of the
kind being quoted, so a merchant that discovers its deployment gets it for
free. Only a merchant that pins **both** `network` and a whole `asset`
discovers nothing, and that one must name `synchronizerId` on the way to pay —
it fails loudly rather than quoting a domain nobody chose.

The middleware compares the echoed value against its own, as `policy_synchronizer`:
a payer that echoed another would otherwise have the verifier pin the transfer
to that instead.

**`requirementsHash` changes for every payment**, the canonical form having
gained a field. The golden vector is regenerated and checked against the
facilitator's own RFC 8785 canonicalizer, which produces the same bytes:

```
d49b82dc50e5d6a80742d88a6f9f4972c7e7eb6bd50869cdda1c080d1e749e5c
```

`PreparedTransaction.metadata` is now read, so a transaction carrying two of
them is refused rather than having one silently win: two metadata blocks are
two answers to which domain the payer committed to.
