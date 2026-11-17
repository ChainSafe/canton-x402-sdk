---
"@chainsafe/x402-core": major
"@chainsafe/x402-express": major
---

**Breaking. The published API surface is now a deliberate list: 142 names down
to 108.**

Until now the surface was a side effect of which files happened to be
`export *`-ed, so roughly half of what the package published had never been
chosen by anyone. The next release is 1.0.0, after which every published name
is frozen for the whole major — so each one is now a decision, and CI fails if
the built declarations stop matching `packages/x402-core/api-surface.txt`.

### If you used one of these

**Validation schema objects** — `VerifyRequestSchema`,
`VerifyResponseValidSchema`, `VerifyResponseInvalidSchema`,
`SettleResponseSuccessSchema`, `SettleResponseErrorSchema`,
`SupportedKindSchema`, `SupportedInstrumentSchema`, `CantonSupportedExtraSchema`,
`AssetSpecSchema`, `InstrumentIdSchema`, `PaymentExtensionsSchema`,
`ResourceInfoSchema`, `CantonPaymentInnerSchema`, `CantonPaymentPayloadSchema`,
`CantonPaymentRequiredResponseSchema`, `CantonPaymentRequirementsSchema`,
`CantonRequirementsExtraSchema`, and the three `X402Payment*EnvelopeSchema`.

→ Use the matching **type** and `is*` guard; both are unchanged. The rule
applied throughout is: publish the type always, publish the runtime object only
where it is the single reachable way to do something the type cannot. Two cases
qualify and remain public — the **picklists** `VerifyInvalidReasonSchema` and
`SettleErrorReasonSchema`, where the object *is* the enumerable list of codes,
and the **validators with no `is*` twin**, `VerifyResponseSchema`,
`SettleResponseSchema` and `SupportedResponseSchema`.

This keeps valibot out of the types a caller writes against: `SettleResponse`,
`CantonPaymentRequirements` and the rest are now plain structural types in the
published `.d.ts`, not `v.InferOutput<...>` of a schema. Core also stops
*importing* valibot in its declarations — it bundles valibot but never depended
on it, so until now every published type resolved to `any` for anyone with
`skipLibCheck` on. `dts: { resolve: ["valibot"] }` inlines the types the way
`noExternal` already inlined the code.

It does not get valibot out of the package. The five schema objects above are
valibot values and carry valibot's own `PicklistSchema`, `VariantSchema` and
`ObjectSchema` types, so a valibot major can still be breaking for those five —
and only those five.

**The `parse*` functions** — `parseCantonPaymentInner`,
`parseCantonPaymentPayload`, `parseCantonPaymentRequirements`,
`parseCantonVerifyRequest`, `parseX402Request`.

→ Use the `is*` guards. The parsers threw valibot's `ValiError`, which made the
validation library part of the contract. If you need a *reason* rather than a
boolean, say so — a core-owned error type can be added without a breaking
change, whereas removing these later could not.

**`CantonPaymentObject`, `CantonPaymentObjectRequest`,
`CantonPaymentObjectResponse`** and the `DisclosedContract` pair are **deleted**,
not merely unexported. No x402 specification defines `POST /payment-object`, the
facilitator removed it as unused, and `CantonPaymentObject` carried
`facilitatorFee` / `totalAmount` — a fee structure still being designed, which
1.0.0 would have frozen wrong.

**`findTransferMismatch` and `MAX_PAYMENT_DEPTH`** are internal now: an
implementation detail of the verifier, and a defensive limit on the
payment-header codec rather than a protocol value.

### One addition

**`CantonRequirementsExtraKey`** — the union of `CantonRequirementsExtra`'s keys.
Needed because that type is inferred from a `looseObject`, so it carries an index
signature and `keyof` on it collapses to `string`; the set of keys was previously
obtainable only by reading `.entries` off the schema object.
`@chainsafe/x402-express` uses it for its rule-table drift check and ships in the
same release.

### Kept

**`encodePaymentResponseHeader`, `decodePaymentResponseHeader` and
`isSettlementPending`** arrived after this list was drawn. All three are
published: `@chainsafe/x402-express` writes the `PAYMENT-RESPONSE` header with
the encoder, so a caller has to be able to read it back, and the guard is how a
caller tells a pending settlement from a failed one.
