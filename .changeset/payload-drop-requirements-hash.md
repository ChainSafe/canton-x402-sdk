---
"@chainsafe/x402-client": major
"@chainsafe/x402-core": major
"@chainsafe/x402-express": major
"@chainsafe/x402-server-sdk": major
---

**Breaking.** The payment payload no longer carries `requirementsHash`, which the
Canton scheme spec does not define.

```diff
  "payload": {
    "assetTransferMethod": "transfer-factory",
    "payer": "buyer::1220…",
    "preparedTransaction": "…",
    "preparedTxHash": "…",
    "signature": "…",
-   "requirementsHash": "…",
    "publicKey": "…",
```

The hash was never signed (the signature covers `preparedTxHash`), so anyone
holding a payload could recompute it for other requirements. What binds a
payment to its requirements is the decoded transfer: the verifier checks its
sender, receiver, instrument and amount against them, as before.

The verifier no longer checks it and `CantonX402Payer` no longer sends it. A
payload that still carries one is not refused: the field is ignored.
`requirementsHashMatches` is removed from `@chainsafe/x402-core`.

`requirementsHash()` itself stays exported, as a stable hash of one
`PaymentRequirements`. `requirements_hash_mismatch` stays in the verify and
settle reason lists, so a response from a facilitator that still sends it
parses, but this package's verifier no longer returns it.

`@chainsafe/x402-client` and `@chainsafe/x402-express` are major because the
payload type reaches their signatures: `FacilitatorClient.verify` and `settle`
take it, and `req.x402.payload` is one.
