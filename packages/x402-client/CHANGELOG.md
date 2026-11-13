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

- bee745f: **Breaking.** The payment payload no longer carries `payer`, which the Canton
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
  payment to its requirements is the decoded transfer: the verifier checks it
  against them, as before.

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

- 98a52b3: **Breaking.** The payment is the x402 v2 `PaymentPayload` the spec defines. The
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

  **The payment header carries the payment alone**, as base64 of its JSON. The
  `{ payment, requirements }` wrapper is gone: `accepted` is the requirements the
  payment was built against. `encodePaymentHeader(payload)` takes one argument,
  `decodePaymentHeader` returns the payment, and `DecodedPaymentHeader` is
  removed (also from `@chainsafe/x402-express`'s re-exports). A header in the old
  shape, a payment with no `accepted`, or one whose `accepted` is not a whole
  `PaymentRequirements`, fails to decode.

  **`accepted` is a `PaymentRequirements`**, as the spec defines it.
  `X402PaymentPayload.accepted` is typed `X402PaymentRequirements`, and
  `X402PaymentPayload` takes the `extra` type as a second parameter, which
  `X402Request` passes through. `isX402PaymentPayload`, `isCantonPaymentPayload`
  and `decodePaymentHeader` check it with `X402PaymentRequirementsEnvelopeSchema`,
  as `paymentRequirements` is checked: an `accepted` whose `scheme`, `network`,
  `amount`, `asset` or `payTo` is missing or empty, or whose `maxTimeoutSeconds`
  is not a whole number of at least 1, is refused. Its `extra` is not checked. `X402PaymentRequirements.resource` is optional, since the spec's
  `PaymentRequirements` has no `resource`; canton-exact requirements still
  require it.

  **The verifier applies spec Rule 1 to `accepted`.** Its `scheme` must be
  `exact` and its `network` must equal the requirements', or the answer is
  `scheme_mismatch` / `network_mismatch`. It compares nothing else in `accepted`:
  the transfer is bound to `paymentRequirements`, as before. A payment without a
  usable `accepted`, including the pre-spec envelope, is `scheme_mismatch`, and an
  `x402Version` other than 2 is `internal_error`. `schemeNetworkMatches` reads
  `accepted`, and `createVerifierRegistry` routes on the requirements' scheme and
  network instead of the payment's.

  `CantonX402Payer` sets `accepted` to the requirements it pays, and
  `createX402Fetch` sends the payment alone.

  The express middleware takes the requirements to verify from the payment's
  `accepted`: it narrows them (`bad_payload` if the codec refuses the `accepted`,
  an empty `amount` among them; `policy_requirements_invalid` if they are not
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
  the payment header near 10 KB.

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

### Minor Changes

- ffa5dd2: Cache `GET /v2/supported`, and stop typing verify/settle more narrowly than the
  protocol.

  `supported()` now reuses its answer for `supportedTtlMs` — default five minutes,
  `0` to fetch every time. What the endpoint returns is what a deployment settles:
  the (scheme, network) kinds and, in `kinds[].extra`, the synchronizer, the
  instruments and the transfer methods. Those change when a facilitator is
  redeployed, not per request, so a caller that configures from them should not
  pay a round trip each time it wants to quote.

  Three things the cache does beyond holding a value:

  - **Concurrent callers share one request.** A cold start under load costs one
    round trip, not one per caller.
  - **A failed refresh falls back to the last value.** A facilitator blip should
    not stop a merchant quoting terms that have not changed. With no previous
    value the error propagates as before.
  - **A failure is not cached.** The next call retries.

  `supported({ refresh: true })` bypasses it.

  ```ts
  const facilitator = new FacilitatorClient(url, { apiKey, supportedTtlMs: 60_000 });
  ```

  ### verify/settle take the envelope types

  ```diff
  - verify(payload: CantonPaymentPayload, requirements: CantonPaymentRequirements)
  + verify(payload: X402PaymentPayload<unknown>, requirements: X402PaymentRequirements<unknown>)
  ```

  `/v2/verify` and `/v2/settle` are scheme-agnostic on the wire — the envelope is
  `{x402Version, paymentPayload, paymentRequirements}` whatever the scheme — so the
  client had no business accepting only canton-exact's concrete shapes. This is a
  widening, so every existing call still compiles; it is what lets a scheme-generic
  merchant middleware use the same client.

### Patch Changes

- Updated dependencies [90ffd99]
- Updated dependencies [39925bd]
- Updated dependencies [e86b4fb]
- Updated dependencies [0848beb]
- Updated dependencies [e9b6cfb]
- Updated dependencies [5b9e1f6]
- Updated dependencies [10172f4]
- Updated dependencies [bee745f]
- Updated dependencies [d632539]
- Updated dependencies [98a52b3]
- Updated dependencies [8efcdee]
- Updated dependencies [faa61e2]
- Updated dependencies [c6f8756]
- Updated dependencies [b3a1e29]
- Updated dependencies [44948df]
- Updated dependencies [a6ec748]
- Updated dependencies [dc43ab7]
- Updated dependencies [11f8910]
- Updated dependencies [deeae58]
- Updated dependencies [14f9c6b]
- Updated dependencies [5717756]
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
