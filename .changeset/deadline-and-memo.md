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

`transfer_expired` is the only expiry left, and it says something narrower than
the one it replaces: not that the quote went stale, but that the transfer the
payer signed can no longer settle, so the client should prepare another against
the quote it already has.

**Rule 12, memo.** When the merchant quotes one, the transfer's metadata must
carry the identical value under `x402.memo`, or the payment is
`transfer_mismatch` with detail `memo`. A memo the merchant did not quote is refused
too: `x402.memo` is the scheme's key, not the payer's namespace, so an unquoted
transfer must carry none — a payer naming its own order there would otherwise
be credited against it. Note that the wallet SDK's own `memo` parameter
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

There is also a new optional `preSettle` hook, because Rule 12 on its own
proves less than it looks: it compares the transfer against the requirements
the PAYER echoed, so a payer can echo no memo and sign none, or echo another
order's memo and sign that — either way the two agree, and the middleware keeps
no record of what it issued. `preSettle` is where that record goes. It takes
the payload, the echoed requirements, the `payer` and the verify response, runs
after verify and before any settle, and returns a reason to refuse (answered as
a 402 carrying that code) or nothing to accept. Not memo-specific: any check
needing merchant state belongs there.

After verify rather than before it, though a refusal is then one round-trip
dearer. Before verify, the requirements handed to the hook are a payer's claim
that nothing has yet held against the signed transfer, so a merchant
reconciling a memo — or reserving stock, or marking an order claimed, which is
what this hook is for — would be acting on an unverified value. It is also the
only point at which `payer` exists, the payload having stopped carrying one.
Wrong scheme, payee, resource or amount are still refused by policy before any
verify, and verify moves no funds; settle does, and a refusal precedes it.

Found in review by @dimartiro.

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
