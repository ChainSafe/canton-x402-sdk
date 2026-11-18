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
the build stops matching `packages/x402-core/api-surface.txt`. It compares every
`export` statement in the built declarations, and separately checks that each
name not marked `type` is really exported by the built ESM and CJS — a name can
be demoted to type-only without the declarations moving at all.

### If you used one of these

**Validation schema objects** — `VerifyRequestSchema`,
`VerifyResponseValidSchema`, `VerifyResponseInvalidSchema`,
`SettleResponseSuccessSchema`, `SettleResponseErrorSchema`,
`SupportedKindSchema`, `SupportedInstrumentSchema`, `CantonSupportedExtraSchema`,
`AssetSpecSchema`, `InstrumentIdSchema`, `PaymentExtensionsSchema`,
`ResourceInfoSchema`, `CantonPaymentInnerSchema`, `CantonPaymentPayloadSchema`,
`CantonPaymentRequiredResponseSchema`, `CantonPaymentRequirementsSchema`,
`CantonRequirementsExtraSchema`, and the three `X402Payment*EnvelopeSchema`.

→ **Eight have an `is*` guard**, unchanged, and so is the type: use
`isCantonVerifyRequest`, `isCantonPaymentInner`, `isCantonPaymentPayload`,
`isCantonPaymentRequiredResponse`, `isCantonPaymentRequirements`,
`isX402PaymentPayload`, `isX402PaymentRequirements` and
`isX402PaymentRequiredResponse`.

→ **The other twelve have no guard** — `VerifyResponseValidSchema`,
`VerifyResponseInvalidSchema`, `SettleResponseSuccessSchema`,
`SettleResponseErrorSchema`, `SupportedKindSchema`, `SupportedInstrumentSchema`,
`CantonSupportedExtraSchema`, `AssetSpecSchema`, `InstrumentIdSchema`,
`PaymentExtensionsSchema`, `ResourceInfoSchema` and
`CantonRequirementsExtraSchema`. These are the parts the larger validators are
assembled from, not messages anything receives on its own. Their **types stay
published**: validate at the level that has a guard and use the type for the
part. If you were validating one of them standalone, say so — a guard is an
addition, not a breaking change, which is why none is published on spec.

The rule applied throughout is: publish the type always, publish the runtime
object only where it is the single reachable way to do something the type cannot
*and* the thing is received whole. Two cases qualify and remain public — the
**picklists** `VerifyInvalidReasonSchema` and `SettleErrorReasonSchema`, where
the object *is* the enumerable list of codes, and the **whole-response
validators with no `is*` twin**, `VerifyResponseSchema`, `SettleResponseSchema`
and `SupportedResponseSchema`.

Core's declarations no longer import valibot. It was only a devDependency, so
for anyone without it every schema-derived type (`SettleResponse`,
`CantonPaymentRequirements` and the rest) resolved to `any` under
`skipLibCheck`. `dts: { resolve: ["valibot"] }` now inlines valibot's types
the way `noExternal` already inlines its code.

That does not take valibot out of the API. Those types are still inferred from
valibot schemas, and the five schema objects above are valibot values, so a
valibot major in core can still be breaking for both.

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
