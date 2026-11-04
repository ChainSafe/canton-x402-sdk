---
"@chainsafe/x402-client": major
"@chainsafe/x402-core": major
"@chainsafe/x402-express": major
"@chainsafe/x402-server-sdk": major
---

**Breaking.** The payment payload's hash and signature fields take the names
and encodings the Canton scheme spec defines.

```diff
- "preparedTransactionHash": "7fdec2bf…",
- "partySignature": "<hex, 128 digits>",
+ "preparedTxHash": "7fdec2bf…",
+ "signature": "<base64, 88 characters>",
```

`signature` is a re-encode, not only a rename: the spec carries it as base64.
The verifier accepts only canonical standard base64 of exactly 64 bytes. A hex
signature is valid base64 too, but it decodes to 96 bytes, so it is refused
instead of being read as some other signature. `preparedTxHash` must be 64
lower-case hex digits. Either one in any other form is `bad_signature`.

`hashingSchemeVersion` is optional, and an absent one means
`HASHING_SCHEME_VERSION_V2`, as the spec says. `CantonX402Payer` still sends
the version prepare used.

`signHash` and `verifySignature` keep working in hex. The new
`signatureToBase64` and `signatureFromBase64` convert at the payload boundary.

No compatibility shim: the old field names are not read. Clients and
facilitators move together, as with the rest of the 1.0 set.

`@chainsafe/x402-client` is major too: `FacilitatorClient.verify` and `settle`
take the payload type, so the change reaches its signatures. Without its own
changeset it would only get a patch bump from the core dependency.
