---
"@chainsafe/x402-express": minor
---

Configure the middleware from the facilitator, fix what a second advertised
quote — or a successful payment — used to do, and stop the flow being
canton-shaped.

```diff
  requirements: {
-   network: "canton:devnet",
    payTo: "merchant::1220…",
-   asset: { instrumentId: { id: "Amulet", admin: "DSO::1220…" } },
+   asset: "Amulet",
    amount: "500000000",
  }
```

`network` is now optional and `asset` takes an instrument id. Left out or named
by id, the rest is read from the facilitator's `/v2/supported`: the network it
settles, and the registry party it validates holdings against. That party is the
one the facilitator checks a payment against, so reading it from there removes
the second copy that had to be kept true by hand when a deployment moved. Pin
`network` and pass the whole `AssetSpec` to skip the lookup entirely — a test
asserts `/v2/supported` is never called then. An `AssetSpec` on its own still
reads it, for the network, narrowed to the instrument it pins.

Note the id, not the symbol: Canton Coin is `"Amulet"`, and `"CC"` is what goes
on the wire. It is the one instrument where the two differ, and an id the
deployment does not carry is refused with the ids it does.

A facilitator settling more than one network is an error rather than a guess,
because a price means nothing without knowing which chain it settles on. Name
one with `network`.

### One resource, a list of ways to pay

`requirements` is the merchant's terms, not one quote beside some extras:

```diff
  requirements: {
    payTo: "merchant::1220…",
-   amount: "500000000",
+   resource: "https://merchant.example/report",
+   accepts: [
+     { amount: "500000000", asset: "Amulet" },  // 0.05 CC
+     { amount: "250000", asset: "USDCx" },     // priced separately
+   ],
  }
```

That is the shape x402 v2 §5.1.2 defines: `PaymentRequired` names ONE resource
and lists the ways to pay, and `PaymentRequirements` carries no resource of its
own. `additionalAccepts` is gone with the asymmetry it existed to paper over —
it took finished requirements, so those entries got no discovery, no defaults
and no per-challenge reference, and the merchant hand-wrote the registry admin
that discovery exists to supply.

Now every entry is a spec. Each gets discovery and its own minted `memo`, the
shared fields are named once and overridable per entry, and no entry is
privileged. A builder returns the whole list: `(req) => CantonPaymentRequirements[]`.

### Every way to pay says what it is priced in

`asset` is required on every `accepts[]` entry, as an instrument id or as a
whole `AssetSpec`.

`amount` is atomic units of *something*, and an entry that left the asset to
the facilitator's list meant 0.05 CC against a deployment settling Amulet and
0.05 USDCx against one settling USDCx — the same config, a different sale.
Worse, two entries could resolve to the same instrument at different prices,
which a payer settles by taking the cheaper, and a facilitator settling two
instruments made every request a 500 rather than only the ambiguous entry.

Naming it by id does not skip discovery: the registry `admin` still comes from
`GET /v2/supported`, which is the point — that party is what the facilitator
validates holdings against, so there is no second copy to keep true. Only
`network` and a whole `AssetSpec` together skip it.

Either form narrows discovery to the instrument it names. A pinned `AssetSpec`
used not to, so the richer form did less than the plain id: against a
facilitator settling two instruments, `asset: "Amulet"` quoted and
`asset: { instrumentId: … }` failed as ambiguous. Found in review by
@dimartiro.

The network can still be ambiguous, and still is an error rather than a guess:
a facilitator settling the instrument on two networks needs `network` naming
one.

**And no two entries may name the same asset.** Two ways to pay in one asset
leave a payer nothing to choose on but price, so the dearer can never be paid.
`paymentRequired()` throws when the route is mounted — this is merchant config,
not anything a request changes, so it fails at startup rather than answering
500 to every request. Naming an asset by id and pinning the equivalent
`AssetSpec` are caught as the same asset. An entry whose `asset` is a
`(req) => …` resolver cannot be read without a request and is not checked.

An empty `accepts` throws there too, for the same reason — it was a 500 per
request before.

Schemes say what distinguishes their own entries, through the new optional
`SchemeAdapter.distinctKey`.

Found in review by @dimartiro.

### One way to pay that cannot be quoted no longer takes the others with it

Quotes are built before verify, and building was all-or-nothing: an entry the
facilitator could not answer for — an instrument it stopped carrying, say —
turned the whole route into 500s, **paid requests included**. A payer holding
good terms for another entry was refused while trying to pay.

Each entry is now resolved on its own. One that cannot be quoted is left out of
the 402 and the rest are offered; a payment for one that quoted is unaffected.
Only when NO entry can be quoted does the request fail, since there is then
nothing to answer with.

`onQuoteError` is the new optional hook that says so, naming the entry and the
reason, because nothing else would: the 402 simply has fewer entries. It fires
once per dropped entry per request and a throw from it is swallowed, as with
`onReject`.

**A merchant's own mistake is never skipped.** A malformed `amount`, an empty
`accepts`, two entries in one asset — those are config, they throw as
`TermsError`, and dropping the entry would hide the typo instead of reporting
it. Only a failure to quote against the facilitator is skipped.

A facilitator that starts advertising a second **network** remains a hard
failure rather than a skip: it makes every entry ambiguous at once, so there is
nothing left to serve, and picking a chain the merchant did not name would be
worse than refusing. Pin `network` to settle it.

Found in review by @dimartiro.

**`onReject` names the payment it is about.** `PaymentRejectionInfo` gains an
optional `payment` — the payload, the requirements as `preSettle` received
them, and the payer. `preSettle`'s docs invite reserving stock or marking an
order claimed, and settle can fail afterwards; before this there was no way to
tell which order to release short of decoding the header out of `req` again.
Absent when nothing was decoded: an unpaid request, a header that would not
decode, a failure to build the terms. `PaymentRejectionInfo` is generic over
the scheme's types now, defaulting to canton-exact's. Found in review by
@dimartiro.

### Three fixes

**A successful payment no longer mints a second merchant reference.** The `memo`
generator is documented as once per challenge and may record an order, but it
ran whenever requirements were built — including on the paid request that
completed the sale, booking a second order for it. It is now called only when a
challenge is issued.

**A payer can pay the second way to pay, not just the first.** The echoed
requirement was held against the first quote alone, so paying an advertised
alternative was refused as if it undercut the price. The middleware now works out which
advertised quote a payment is for and holds it against that one; when a payment
matches none, the reported reason comes from the quote it got furthest through.

**Policy comparison is derived from a schema, not hand-kept.** Each field is
classified exactly once in a table keyed off the schema's own entries — the
common fields in the middleware, `extra` in the scheme adapter — so a field
added to either fails the build until someone decides what comparing it means.
The previous hand-written list silently ignored anything nobody remembered to
add.

Two consequences of that table: `extra.executeBeforeSeconds` is now compared,
refused as `policy_execute_before`, and `description` is deliberately not, since
it does not reach the ledger.

That comparison is echo fidelity, not a bound on the deadline. The payer folds
the value into the transfer's absolute `executeBefore`, and the verifier checks
only that the deadline is still ahead of now — with no upper bound — so a
transfer signed much further out than the quote still verifies while echoing
the quoted number. Closing that means comparing the signed deadline against
`now + executeBeforeSeconds` with an allowance for clock skew, which is the
verifier's job and not this change's — tracked in #115. Found in review by
@dimartiro.

### The flow is no longer canton-shaped

`paymentRequired()` is generic over a **scheme adapter**. It keeps the HTTP flow
and the fields x402 v2 gives every scheme; the adapter owns `extra` — what goes
in it, how an echoed one is compared, and where a per-challenge reference lives.

```ts
app.use("/paid", paymentRequired<VoucherSpec, VoucherRequirements, VoucherPayload>({
  facilitator,
  scheme: voucherScheme,
  requirements: { payTo: "shop::1", accepts: [{ amount: "10", book: "autumn-2026" }] },
}));
```

Canton's `exact` is the default (`cantonExact`) and nothing changes for a
merchant using it: `paymentRequired` keeps a non-generic overload, so an inline
requirements object is contextually typed against the concrete canton shapes
exactly as before. `RequirementsSpec` is the shared terms plus `accepts`,
generic over the scheme's spec and defaulting to `CantonRequirementsSpec`; one
entry is an `AcceptSpec<TSpec>`, that spec without the shared terms.

**A scheme names its own error code for an unreadable payer.** When neither the
facilitator nor the adapter can say who paid, the refusal carries
`SchemeAdapter.unreadablePayerReason` — canton-exact's
`invalid_exact_canton_malformed_payload` — rather than a canton code on every
scheme. The protocol-level `transfer_mismatch` stays in `extensions.reason` for
a reader that knows that one and not the scheme's, and is the default for an
adapter that names none.

New exports: `SchemeAdapter`, `SchemeQuote`, `SchemeContext`,
`BaseRequirementsSpec`, `AcceptSpec`, `SharedTerms`, `Resolvable`, `FieldRule`,
`RuleTable`, `RequirementsBuilder`, `PaymentRejectionInfo`, `X402RequestState`,
`DEFAULT_MAX_TIMEOUT_SECONDS`, `cantonExact`, `CantonRequirementsSpec`, and the
`compareQuote` / `sameValue` / `resolve` helpers an adapter needs.

**A new guard.** The decoded payment is checked by the scheme before
anything reads a field off it. The envelope is a loose object — `payload.payload`
is `{}` as far as it is concerned — so a payload missing the fields the scheme
needs used to reach `payload.payload.payer` and the facilitator. It is now a
`402 policy_payload_invalid`, costing no verify.

That is a deliberate difference from the code this replaces, which let such a
payload reach the verifier and answered the verifier's
`invalid_exact_canton_malformed_payload`. Refusing it here is earlier and
cheaper, and the scheme's guard is the only thing that has checked the payload
at that point; the verifier's code still answers when a transfer decodes but
does not hold up.
