---
"@chainsafe/x402-client": major
"@chainsafe/x402-core": major
"@chainsafe/x402-express": major
"@chainsafe/x402-server-sdk": major
---

**Breaking.** The payment payload carries `assetTransferMethod`, which the
Canton scheme spec requires in the payload as well as in the requirements'
`extra`.

```diff
  "payload": {
+   "assetTransferMethod": "transfer-factory",
    "payer": "buyer::1220…",
    "preparedTransaction": "…",
```

It is a literal, as in `extra`: `"transfer-factory"` is the only method
Canton's `exact` defines. A payload without it, or with any other value, fails
the verifier's shape check (`internal_error`).

`CantonX402Payer` sends it, and its `supports()` now also requires
`extra.assetTransferMethod` to be `"transfer-factory"`. `createX402Fetch` passes
a 402's `accepts[]` on without validating it, so without this check a merchant
asking for another method would still be paid by a transfer factory.

`@chainsafe/x402-client` and `@chainsafe/x402-express` are major because the
payload type reaches their signatures: `FacilitatorClient.verify` and `settle`
take it, and `req.x402.payload` is one.
