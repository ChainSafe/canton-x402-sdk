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
    amount: "500000000",
  }
```

`network` and `asset` are now optional. Left out, they are read from the
facilitator's `/v2/supported`: the network it settles, and the instrument with
the registry party it validates holdings against. That party is the one the
facilitator checks a payment against, so reading it from there removes the
second copy that had to be kept true by hand when a deployment moved. Pin either
field to keep today's behaviour and skip the lookup entirely — a test asserts
`/v2/supported` is never called then.

A facilitator settling more than one network or instrument is an error rather
than a guess, because a declarative spec carries one price and a price means
nothing without the instrument it is denominated in. Name one with `network` or
`instrument`.

### Three fixes

**A successful payment no longer mints a second merchant reference.** The `memo`
generator is documented as once per challenge and may record an order, but it
ran whenever requirements were built — including on the paid request that
completed the sale, booking a second order for it. It is now called only when a
challenge is issued.

**A payer can pay an `additionalAccepts` entry.** The echoed requirement was
held against the first quote alone, so paying an advertised alternative was
refused as if it undercut the price. The middleware now works out which
advertised quote a payment is for and holds it against that one; when a payment
matches none, the reported reason comes from the quote it got furthest through.

**Policy comparison is derived from a schema, not hand-kept.** Each field is
classified exactly once in a table keyed off the schema's own entries — the
common fields in the middleware, `extra` in the scheme adapter — so a field
added to either fails the build until someone decides what comparing it means.
The previous hand-written list silently ignored anything nobody remembered to
add.

Two consequences of that table: `extra.executeBeforeSeconds` is now compared (it
reaches the ledger as the transfer's `executeBefore`, so a payer echoing its own
value was choosing how long the quote stayed settleable — refused as
`policy_execute_before`), and `description` / `maxTimeoutSeconds` are
deliberately not, since neither reaches the ledger.

### The flow is no longer canton-shaped

`paymentRequired()` is generic over a **scheme adapter**. It keeps the HTTP flow
and the fields x402 v2 gives every scheme; the adapter owns `extra` — what goes
in it, how an echoed one is compared, and where a per-challenge reference lives.

```ts
app.use("/paid", paymentRequired<VoucherSpec, VoucherRequirements, VoucherPayload>({
  facilitator,
  scheme: voucherScheme,
  requirements: { payTo: "shop::1", amount: "10", book: "autumn-2026" },
}));
```

Canton's `exact` is the default (`cantonExact`) and nothing changes for a
merchant using it: `paymentRequired` keeps a non-generic overload, so an inline
requirements object is contextually typed against the concrete canton shapes
exactly as before. `RequirementsSpec` is now an alias of
`CantonRequirementsSpec`.

New exports: `SchemeAdapter`, `SchemeQuote`, `SchemeContext`,
`BaseRequirementsSpec`, `FieldRule`, `RuleTable`, `X402RequestState`,
`cantonExact`, `CantonRequirementsSpec`, and the `compareQuote` / `sameValue` /
`resolve` helpers an adapter needs.

**A new guard.** The decoded `X-PAYMENT` is checked by the scheme before
anything reads a field off it. The envelope is a loose object — `payload.payload`
is `{}` as far as it is concerned — so a payload missing the fields the scheme
needs used to reach `payload.payload.payer` and the facilitator. It is now a
`402 policy_payload_invalid`, costing no verify.
