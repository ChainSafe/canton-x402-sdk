---
"@chainsafe/x402-client": major
"@chainsafe/x402-core": major
"@chainsafe/x402-express": major
"@chainsafe/x402-server-sdk": major
---

**Breaking.** The payment is the x402 v2 `PaymentPayload` the spec defines. The
scheme and network are no longer top-level: they travel inside `accepted`, the
`accepts[]` entry the payer chose. `resource` and `extensions` are optional and
passed through, and either may be `null`.

```diff
  {
    "x402Version": 2,
-   "scheme": "exact",
-   "network": "canton:devnet",
+   "accepted": { "scheme": "exact", "network": "canton:devnet", "amount": "500000000", … },
    "payload": { "assetTransferMethod": "transfer-factory", … }
  }
```

**The `X-PAYMENT` header carries the payment alone**, as base64 of its JSON. The
`{ payment, requirements }` wrapper is gone: `accepted` is the requirements the
payment was built against. `encodePaymentHeader(payload)` takes one argument,
`decodePaymentHeader` returns the payment, and `DecodedPaymentHeader` is
removed (also from `@chainsafe/x402-express`'s re-exports). A header in the old
shape, or a payment with no `accepted`, fails to decode.

**The verifier applies spec Rule 1 to `accepted`.** Its `scheme` must be
`exact` and its `network` must equal the requirements', or the answer is
`scheme_mismatch` / `network_mismatch`. Nothing else in `accepted` is checked:
the transfer is bound to `paymentRequirements`, as before. A payment without a
usable `accepted`, including the pre-spec envelope, is `scheme_mismatch`, and an
`x402Version` other than 2 is `internal_error`. `schemeNetworkMatches` reads
`accepted`, and `createVerifierRegistry` routes on the requirements' scheme and
network instead of the payment's.

`CantonX402Payer` sets `accepted` to the requirements it pays, and
`createX402Fetch` sends the payment alone.

The express middleware takes the requirements to verify from the payment's
`accepted`: it narrows them (`policy_requirements_invalid` if they are not
canton-exact requirements), checks them against the merchant's terms, and
forwards them as `paymentRequirements`, as it did with the echoed slot. It now
also refuses an `accepted` whose `maxTimeoutSeconds` is not the merchant's
(`policy_timeout`), and a header nested more than 64 levels deep
(`bad_payload`), which used to fail with a 500 when the facilitator request was
serialised.

`X402Payer.authorize` must return a payment whose `accepted` is the
requirements it was given: `createX402Fetch` sends the payment alone, and the
merchant takes the requirements from it.

`@chainsafe/x402-client` is major because the payload type reaches its
signatures: `FacilitatorClient.verify` and `settle` take it.
