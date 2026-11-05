---
"@chainsafe/x402-core": major
"@chainsafe/x402-express": major
"@chainsafe/x402-server-sdk": major
---

**Breaking.** `extra.executeBeforeSeconds` and `extra.memo`, and the two
verification rules that give them teeth.

```diff
  "extra": {
    "assetTransferMethod": "transfer-factory",
    "instrumentId": { "id": "Amulet", "admin": "DSO::1220…" },
+   "executeBeforeSeconds": 120,
+   "memo": "invoice-2024-001"
  }
```

Unlike `maxTimeoutSeconds`, these reach the ledger. The payer folds
`executeBeforeSeconds` into the transfer's absolute `executeBefore` and copies
`memo` into its metadata, so both end up inside what gets signed — and the
verifier checks the transfer, not the quote.

**Rule 10, deadline.** A transfer whose `executeBefore` has passed, or is
within five seconds of it, is refused with the new `transfer_expired`. Settling
is not instantaneous, so accepting one about to lapse buys the wasted relay the
rule exists to avoid. An absent deadline counts as expired: a real transfer
always carries one, and reading a missing field as "no deadline" would make the
check skippable by leaving it out.

`transfer_expired` is separate from `requirements_expired` because the client
does different things with them — fetch a new 402, or prepare a new transfer
against the quote it already has.

**Rule 12, memo.** When the merchant quotes one, the transfer's metadata must
carry the identical value under `x402.memo`, or the payment is
`transfer_mismatch` with detail `memo`. An unquoted memo is the payer's own
reference and is ignored. Note that the wallet SDK's own `memo` parameter
writes a different key (`splice.lfdecentralizedtrust.org/reason`), so both can
be present without either standing in for the other.

**The decoder learned two wire shapes it was skipping.** A Daml `Time` is a
protobuf SFIXED64 — wire type 1, eight little-endian bytes — not a varint and
not length-delimited, so a reader that only handled wire-type-2 members read
the deadline back as absent. `TextMap` is now read too, and a repeated
`x402.memo` is refused rather than resolved: two entries are two answers to
what the payer committed to, and any last-wins rule lets a producer show one
value to a reader and another to the engine.

**Middleware.** `executeBeforeSeconds` is a new option defaulting to 120; `memo`
is a new option with no default, because quoting one binds it and an invented
memo would refuse honest payments.

**Payer.** `CantonX402Payer` now sets the transfer's expiry from the quoted
horizon. Left unset the wallet SDK picks 24 hours, which would make the
merchant's horizon decorative and Rule 10 pass on every payment regardless.

The golden canonicalization vector moves again, regenerated from the
facilitator's own canonicalizer and checked against it.

**`nonce` and `validBefore` are gone.** `extra.memo` takes the role `nonce`
actually had: the merchant's order or payment id, used to reconcile and to
refuse a replay early. It does the job better, because Rule 12 binds it into
the transfer the payer signed — `nonce` only ever rode along in echoed
requirements, outside the signature. It is optional, so a merchant that wants
neither simply quotes none; the spec's own replay guard is on-ledger and needs
no off-chain key:

> Once the transfer executes, those holdings are consumed; resubmitting the same
> payload references already-spent holdings, which the ledger rejects. The replay
> guard is therefore native and on-ledger — no off-chain deduplication store is
> required.

`validBefore` goes with it, and nothing replaces it: a quote no longer expires
on its own. The deadline that decides is `executeBefore`, inside what the payer
signed, which Rule 10 enforces. The trade is that a 402 issued long ago can
still be paid at the price it quoted, so a merchant whose prices move should
re-quote rather than rely on the protocol to stale them out.

That removes `requirements_expired` (nothing can produce it), `isExpired`, and
the middleware's `validForSeconds` and `nonce` options. `nonce_replayed`
remains — the guard still exists, it just keys on the memo now.

The facilitator keys its settlement store on `requirements.nonce` today and
will need the same change; its replay column and the four migrations that touch
it move with it.
