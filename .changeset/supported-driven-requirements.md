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

`network` is now optional and `asset` takes an instrument id. `asset` itself
stays required — `amount` is atomic units of something — but naming it by id is
enough, and the rest is read from the facilitator's `/v2/supported`: the
network it settles, and the registry party it validates holdings against. That
party is the one the facilitator checks a payment against, so reading it from
there removes the second copy that had to be kept true by hand when a
deployment moved. Pin `network` and pass the whole `AssetSpec` to skip the
lookup entirely — a test asserts `/v2/supported` is never called then. An
`AssetSpec` on its own still reads it, for the network, narrowed to the
instrument it pins.

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

Now every entry is a spec. Each gets discovery and a minted `memo` — one
between the entries that share a generator, a 402 being one sale — the shared
fields are named once and all but `resource` and `description` are overridable
per entry, and no entry is privileged. A builder returns the whole list: `(req) => CantonPaymentRequirements[]`.

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

That failure keeps the status the cause deserves. Resolving entries separately
gave each its own error, and several of them were wrapped in one plain `Error`
— so a `/v2/supported` outage answered `502` on a route offering one way to
pay and `500 x402_middleware_error` on a route offering two, telling a client
the merchant was broken when the facilitator was down. When every failure is a
`FacilitatorError` it is one cause with several witnesses, and the first is
rethrown as it came. Unrelated failures still report together, each named with
its entry. Found in review by @dimartiro.

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
`PaymentRejectionInfo` is generic over the scheme's types now, defaulting to
canton-exact's.

It is attached at ONE point, once `preSettle` has accepted, which is where an
undo starts being owed. The first cut attached it as soon as the shape checks
passed, and that was a hole: until verify has held the requirements against the
signed transfer they are whatever the header claimed, so an underpriced payment
echoing a reference the merchant issued to someone else handed `onReject` that
reference, and a merchant following the README released an order a different
payer was paying for — at no cost to the sender, the payment never settling. A
refusal before that point now carries `reason` and `details` and no `payment`.
Documented too: a 502 from a settle that threw may mean the answer was lost
rather than the payment, so an undo there is a choice about which way to be
wrong. Found in review by @dimartiro.

**One reference per challenge, not one per way to pay.** A reference generator
may book an order, and a 402 is one sale however many ways it offers to pay for
it. Minting per entry booked N and was paid for one, with nothing in the
generator's arguments — it is given only `req` — to tell the entries apart.
Entries carrying the same generator now share the reference it mints, so a
two-entry 402 books one order and whichever way the payer picks reconciles
against it. Schemes say which quotes share through the new
`SchemeQuote.referenceKey`.

**And the shared terms take a scheme's optional fields, so that is writable.**
Sharing is by function identity, and `memo` was a per-entry field: the natural
way of writing it — the same body in each entry — is two functions, so it still
booked two orders. A merchant could get one only by hoisting the function into
a variable, which nothing said and the type could not express.

A scheme's own fields may now be named once beside `payTo` — `memo` is the one
that needs it — and an entry naming its own overrides it and gets its own
reference, which is the merchant asking for one. `RequirementsSpec` is the
mirror of `AcceptSpec` now: an entry must carry the scheme's fields and may
override the shared ones, so the terms carry the shared ones and may default
the scheme's. It is an intersection rather than an interface for it, since that
half is computed from the scheme's own spec. `amount` and `asset` stay required
on every entry, so naming them at the top level does nothing. Found in review
by @dimartiro.

**An entry no longer erases a shared term with an explicit `undefined`.**
`{ payTo: someVar }` where `someVar` is undefined used to wipe the shared
`payTo`, and `exactOptionalPropertyTypes` is off so nothing caught it. Only keys
an entry gives a value to override.

**`resource` and `description` are not per-entry overrides.** A 402 names ONE
resource (§5.1.2), so entries disagreeing about it would have the envelope
describe one sale and its entries another. A builder returns finished
requirements and so can still disagree; it is refused when it does, rather than
the envelope quietly taking the first entry's.

Found in review by @dimartiro.

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

The generic overload requires `scheme`. Without that, a canton call with an
incomplete way to pay fell through to it, inferred its own `TSpec` from
whatever it was handed, and compiled — `accepts: [{ amount: "500000000" }]`
typechecked and then threw `reading 'instrumentId'` at mount. There is nothing
to fall through to now, so it is a compile error; and for the callers
TypeScript cannot reach — JavaScript, and a resolver returning nothing — the
scheme answers with a `TermsError` naming the problem instead of a TypeError
from two frames down. Found in review by @dimartiro.

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
`BaseRequirementsSpec`, `AcceptSpec`, `SharedTerms`, `FieldRule`, `RuleTable`,
`X402RequestState`, `DEFAULT_MAX_TIMEOUT_SECONDS`, `cantonExact`,
`CantonRequirementsSpec`, and the `compareQuote` / `sameValue` / `resolve`
helpers an adapter needs. `Resolvable`, `RequirementsBuilder` and
`PaymentRejectionInfo` were already exported; the last two change shape.

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
