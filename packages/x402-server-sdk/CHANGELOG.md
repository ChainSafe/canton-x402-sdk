# @chainsafe/x402-server-sdk

## 1.0.0

### Major Changes

- 90ffd99: **Breaking.** `PaymentRequirements.amount` is an integer string of atomic units,
  and the verifier requires the transfer to pay **exactly** that.

  ```diff
  - "amount": "0.05",
  + "amount": "500000000",
  ```

  The spec states the factor only for Canton Coin — _"Integer string of atomic
  units (1 CC = 1e10 units)"_ — but it is the wire's, not CC's. The reference
  facilitator states it for every instrument: _"Every instrument uses 10 decimals
  on the wire (1 token = 10^10 atomic units)"_ ([FTP][ftp], `docs/deployment.md`),
  and its token config carries an id and a symbol with no decimals field.

  This is worth stating because the obvious assumption is wrong: USDC is six
  decimals on EVM and ten here. The unit follows the Daml `Decimal`
  representation, not the token's native denomination.

  [ftp]: https://github.com/FTP-Tech-LLC/x402-canton-facilitator

  **Exact, not a floor.** Rule 4 says the transfer amount MUST equal the quote;
  `amountGte` allowed an overpayment and said so in its docstring. `exact` is the
  scheme's distinguishing property, and a payer who signs for more than was quoted
  loses the difference with no refund path.

  `amountGte` is removed with no replacement export. The comparison lives inline
  in `findTransferMismatch`, where both sides can be named for what they are — a
  two-string helper spanning two units reads the same whichever way round it is
  called.

  **One unit everywhere, including the merchant's own options.** A route now
  declares `amount: "500000000"` rather than `"0.05"`, and the middleware does not
  convert.

  The alternative — keeping merchants in CC and converting — was rejected because
  `paymentRequired` takes either a declarative spec or a
  `(req) => CantonPaymentRequirements` builder under the **same** key, and both
  type `amount` as a string. A merchant moving from one to the other would carry
  `"0.05"` across and silently underquote by 1e10. With one unit there is nothing
  to carry wrong, and a decimal is now refused rather than misread.

  New in `@chainsafe/x402-core`:

  |                                     |                                                                                                                                                                                                                                        |
  | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `isValidAmount`                     | now the **atomic** form — an integer string. It previously accepted decimals.                                                                                                                                                          |
  | `isValidLedgerAmount`               | the on-ledger `Decimal`, ≤10 places — what `isValidAmount` used to be                                                                                                                                                                  |
  | `ledgerToAtomic` / `atomicToLedger` | conversion. Both take `decimals` explicitly — no default, so a call site states the scale it converts at. `null` on malformed input rather than a coerced zero, and `ledgerToAtomic` also refuses more precision than the scale holds. |
  | `WIRE_DECIMALS`                     | the scale itself, `10`                                                                                                                                                                                                                 |

  Removed: `amountGte`.

  `requirementsHash` changes again, because `amount`'s value does.

- 0848beb: **Breaking.** The scheme and network ids are the ones the registered Canton
  scheme spec defines. There is no alias and no grace period.

  Marked `major` because this is part of the 1.0 release that makes the packages
  conform to the registered spec. Nothing ships until that whole set is merged, so
  every breaking change in it lands in one version rather than a run of them.

  ```diff
  - "scheme":  "exact-canton",
  - "network": "canton:1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef…",
  + "scheme":  "exact",
  + "network": "canton:devnet",
  ```

  A conforming client could never pay us before: it reads `exact` and
  `canton:mainnet|testnet|devnet` off the spec, and had no way to learn either
  of the ids we actually used.

  `createCantonExactVerifier(networkId)` now takes no options. `EXACT_SCHEME_ID`
  is the only scheme constant; `EXACT_CANTON_SCHEME_ID` is gone. `MAINNET_NETWORK`
  and `DEVNET_NETWORK` are the registered names rather than `canton:<fingerprint>`,
  and `TESTNET_NETWORK` joins them.

  `LOCALNET_NETWORK` (`canton:localnet`) is new, and `localnetConfig()`'s `network`
  is now optional and defaults to it. The spec's table of three is not a closed set
  — Rule 1 requires only a network the facilitator is configured for — so LocalNet
  gets its own id instead of borrowing DevNet's, which would leave a local and a
  real DevNet facilitator indistinguishable on the wire.

  **The synchronizer fingerprint did not retire** — only its use as a network id
  did. `*_SYNCHRONIZER_ID` and `*_DSO_PARTY` still carry it, and nothing is lost,
  because neither side ever read the synchronizer out of the network id: a payer
  gets it from the participant its wallet SDK is connected to, and a facilitator
  from its own config.

  **`requirementsHash` changes for every payment**, because the hash covers the
  whole requirements object and two of its values are renamed. The algorithm is
  untouched. Any golden vector pinned against it must be regenerated on both
  sides of the wire in the same release.

  **Renamed exact-canton → canton-exact**, because `exact-canton` was the retired
  wire id and keeping it as the API's most visible name left a grep unable to tell
  live code from history. The new order also matches the facilitator's existing
  `V2CantonExact`.

  ```diff
  - import { createExactCantonVerifier } from "@chainsafe/x402-core";
  + import { createCantonExactVerifier } from "@chainsafe/x402-core";
  ```

  The chain stays in the name on purpose: `exact` is the scheme family across
  chains (`specs/schemes/exact/…`), while this verifier is Canton-specific —
  Canton key fingerprints, prepared-transaction decoding, `party::fingerprint`
  suffixes.

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

- a6ec748: **Breaking.** PaymentRequirements takes the shape the registered Canton scheme
  spec defines: `amount` instead of `maxAmountRequired`, and `asset` as a symbol
  with the instrument moved to `extra.instrumentId`.

  ```diff
  - "maxAmountRequired": "0.05",
  - "asset": { "instrumentId": { "id": "Amulet", "admin": "DSO::1220…" } },
  + "amount": "0.05",
  + "asset": "CC",
  + "extra": { "instrumentId": { "id": "Amulet", "admin": "DSO::1220…" } },
  ```

  `asset` is a symbol because that is what the spec carries — `"CC"` for Canton
  Coin, or a registry token's own. A symbol cannot say which registry issued the
  instrument, so `extra.instrumentId` is required and is what the verifier binds
  the transfer against. `assetSymbol()` maps an instrument to its symbol; the one
  case where the two differ is Canton Coin, whose instrument is `Amulet`.

  No compatibility shim: the old spelling is not accepted. Clients and
  facilitators move together.

  **The middleware's own options are unchanged.** A merchant still declares
  `asset: { instrumentId: { id, admin } }`; the symbol is derived and the
  instrument placed in `extra` when the 402 is built.

  **`requirementsHash` changes for every payment**, because the canonical form
  did. Any golden vector pinned against it must be regenerated on both sides of
  the wire in the same release.

  Not included, and still divergent from the spec: `resource` and `description`
  (which the spec puts on PaymentPayload), and `nonce` and `validBefore` (which
  it does not define at all).

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
  - @chainsafe/x402-client@1.0.0

## 0.1.2

### Patch Changes

- ecd453d: Require `@canton-network/wallet-sdk` ^1.6.0, so the ACS read the payer makes
  sends the request body Canton 3.6 accepts.
- 716b9e0: docs: refresh the x402-server-sdk README

## 0.1.1

### Patch Changes

- 28c4a67: Fix the release pipeline so all packages publish. `changeset publish` ran each package's `prepack: tsup` in parallel, and a dependent's type-declaration build could read a sibling's `dist` while that sibling was mid-rebuild, failing to publish `x402-express` and `x402-server-sdk`. The `prepack` hook is removed; the single topological `pnpm build` in CI is now the authoritative build and publish ships those artifacts. No runtime or API change.
- Updated dependencies [28c4a67]
  - @chainsafe/x402-core@0.1.1
  - @chainsafe/x402-client@0.1.1

## 0.1.0

### Minor Changes

- aec5534: First public release on npm.

### Patch Changes

- Updated dependencies [aec5534]
- Updated dependencies [aec5534]
  - @chainsafe/x402-client@0.1.0
  - @chainsafe/x402-core@0.1.0
