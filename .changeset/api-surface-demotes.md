---
"@chainsafe/x402-core": major
---

**Breaking.** Validation schema objects are no longer exported; their types
still are.

One rule throughout: publish the type always, and publish the runtime schema
object only where it is the single reachable way to do something the type
cannot. Two cases qualify and both remain public —

- **picklists**, where the object *is* the enumerable list of codes:
  `VerifyInvalidReasonSchema`, `SettleErrorReasonSchema`
- **validators with no `is*` twin**: `VerifyResponseSchema`,
  `SettleResponseSchema`, `SupportedResponseSchema` — with no guard, the object
  is the only runtime route to validating an untrusted peer's reply

Everything else is internal now: `VerifyRequestSchema`,
`VerifyResponseValidSchema`, `VerifyResponseInvalidSchema`,
`SettleResponseSuccessSchema`, `SettleResponseErrorSchema`,
`SupportedKindSchema`, `SupportedInstrumentSchema`, `CantonSupportedExtraSchema`,
`AssetSpecSchema`, `InstrumentIdSchema`, `PaymentExtensionsSchema`,
`ResourceInfoSchema`, `CantonPaymentInnerSchema`, `CantonPaymentPayloadSchema`,
`CantonPaymentRequiredResponseSchema`, and the three
`X402Payment*EnvelopeSchema` objects.

**If you used one of these**, use its type and the matching `is*` guard. The
types are unchanged. This keeps valibot out of the package's public API, so the
validation library can change without a major.

`findTransferMismatch` and `MAX_PAYMENT_DEPTH` are also internal now. Neither
had a consumer in any repo; the first is an implementation detail of the
verifier, the second a defensive limit on the payment-header codec rather than
a protocol value.
