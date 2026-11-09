---
"@chainsafe/x402-client": major
"@chainsafe/x402-core": major
"@chainsafe/x402-express": major
"@chainsafe/x402-server-sdk": major
---

**Breaking.** The payment payload no longer carries `payer`, which the Canton
scheme spec does not define. The payer is the signed transfer's sender (spec
Rule 8): it sits inside what was signed, where `payer` was a claim beside it.

```diff
  "payload": {
    "assetTransferMethod": "transfer-factory",
-   "payer": "buyer::1220…",
    "preparedTransaction": "…",
    "preparedTxHash": "…",
    "signature": "…",
    "publicKey": "…",
```

Verify still checks the signature against `publicKey`, and the key's
fingerprint must now match the `::` suffix of the transfer's sender, so a
transfer naming another party as sender is `bad_fingerprint`. `publicKey` stays
until the facilitator can read the payer party's keys from the ledger.

The verifier decodes the transfer right after the shape check and the graph
guard, and reports its sender as `payer` on every result from there on.
Results before it (scheme, network, shape, a missing key, a malformed graph)
and an undecodable transaction carry no payer. `findTransferMismatch` takes no
payer, and its `"sender"` detail is gone: the key's fingerprint is what binds
the sender now. The new `decodePayloadTransfer` gunzips and decodes a
payload's `preparedTransaction`.
A payload that still carries `payer` is not refused: the field is ignored, and
it does not change the payer reported.

`CantonX402Payer` no longer sends it.

`req.x402.payer` in `@chainsafe/x402-express` is the facilitator's
`verify.payer`, or the transfer's sender read from the payload when the
facilitator leaves it out (`payer` is optional in a verify response). If
neither is there, the middleware refuses with `transfer_mismatch` before
settling.

`@chainsafe/x402-client` is major because the payload type reaches its
signatures: `FacilitatorClient.verify` and `settle` take it.
