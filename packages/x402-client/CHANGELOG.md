# @chainsafe/x402-client

## 1.0.0

### Major Changes

- e9b6cfb: **Breaking.** The packages need Node 22.2 or later. `engines` was `>=20`.

  Node 20 reached end of life on 2026-04-30. 22 is the oldest line still
  supported, until 2027-04-30, so nobody has to move to the newest Node to use
  the SDK. 22.2 is the first release of 22 with `zlib.crc32`, which the gzip
  codec for the payload's `preparedTransaction` (#75) needs. The codec frames the
  gzip member by hand and checks its CRC32 itself, because `gunzip` accepts the
  concatenated members and trailing bytes that the Canton scheme says to refuse.

  The build target moves from `node18` to `node22` to match.

- 10172f4: **Breaking.** The payment payload carries `assetTransferMethod`, which the
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

- d632539: **Breaking.** The payment payload no longer carries `requirementsHash`, which the
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

- 8efcdee: **Breaking.** The payment payload's hash and signature fields take the names
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

- b3a1e29: **Breaking.** The payload's `preparedTransaction` is base64 of one gzip
  member, as the Canton scheme spec defines, instead of base64 of the bare
  protobuf. A typical transfer goes from 22-27 KB to about 5 KB, which keeps
  the `X-PAYMENT` header near 10 KB.

  The verifier reads it only as exactly one gzip member with no optional header
  fields, at most 8 KiB compressed and 64 KiB decompressed, the spec's
  recommended bounds. Concatenated members, bytes after the member, bytes
  between the deflate stream and the trailer, and a trailer that does not match
  are refused, and a decompression bomb stops at the bound. Anything else is
  `transfer_mismatch` with detail `undecodable`.

  New in `@chainsafe/x402-core`: `gzipPreparedTransaction` and
  `gunzipPreparedTransaction`, with `DEFAULT_MAX_COMPRESSED_BYTES` and
  `DEFAULT_MAX_DECOMPRESSED_BYTES`. `CantonX402Payer` gzips what prepare returns.

  **For a facilitator.** Gunzip the payload's value once and use those bytes in
  both places that read the transaction: the ledger's execute takes the bare
  protobuf, and so does `decodePreparedTransaction`. Passing it the gzipped value
  returns `null`, so a settled amount read from it would silently fall back.

  **Core needs Node.** The codec uses `node:zlib`, and core's entry point exports
  it, so `@chainsafe/x402-core` now runs on Node only (22.2 or later, for
  `zlib.crc32`) and no longer bundles for a browser.

### Patch Changes

- Updated dependencies [90ffd99]
- Updated dependencies [39925bd]
- Updated dependencies [0848beb]
- Updated dependencies [e9b6cfb]
- Updated dependencies [5b9e1f6]
- Updated dependencies [10172f4]
- Updated dependencies [d632539]
- Updated dependencies [8efcdee]
- Updated dependencies [b3a1e29]
- Updated dependencies [a6ec748]
- Updated dependencies [11f8910]
- Updated dependencies [14f9c6b]
  - @chainsafe/x402-core@1.0.0

## 0.1.1

### Patch Changes

- 28c4a67: Fix the release pipeline so all packages publish. `changeset publish` ran each package's `prepack: tsup` in parallel, and a dependent's type-declaration build could read a sibling's `dist` while that sibling was mid-rebuild, failing to publish `x402-express` and `x402-server-sdk`. The `prepack` hook is removed; the single topological `pnpm build` in CI is now the authoritative build and publish ships those artifacts. No runtime or API change.
- Updated dependencies [28c4a67]
  - @chainsafe/x402-core@0.1.1

## 0.1.0

### Minor Changes

- aec5534: First public release on npm.

### Patch Changes

- Updated dependencies [aec5534]
  - @chainsafe/x402-core@0.1.0
