# @chainsafe/x402-express

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

- e86b4fb: **Breaking.** `extra.executeBeforeSeconds` and `extra.memo`, and the two
  verification rules that give them teeth.

  ```diff
    "extra": {
      "assetTransferMethod": "transfer-factory",
      "instrumentId": { "id": "Amulet", "admin": "DSO::1220…" },
  +   "executeBeforeSeconds": 120,
  +   "memo": "invoice-2024-001"
    }
  ```

  Unlike `maxTimeoutSeconds`, these reach the ledger. The payer folds
  `executeBeforeSeconds` into the transfer's absolute `executeBefore` and copies
  `memo` into its metadata, so both end up inside what gets signed — and the
  verifier checks the transfer, not the quote.

  **Rule 10, deadline.** A transfer whose `executeBefore` has passed, or is
  within five seconds of it, is refused with the new `transfer_expired`. Settling
  is not instantaneous, so accepting one about to lapse buys the wasted relay the
  rule exists to avoid. An absent deadline counts as expired: a real transfer
  always carries one, and reading a missing field as "no deadline" would make the
  check skippable by leaving it out.

  `transfer_expired` is the only expiry left, and it says something narrower than
  the one it replaces: not that the quote went stale, but that the transfer the
  payer signed can no longer settle, so the client should prepare another against
  the quote it already has.

  **Rule 12, memo.** When the merchant quotes one, the transfer's metadata must
  carry the identical value under `x402.memo`, or the payment is
  `transfer_mismatch` with detail `memo`. A memo the merchant did not quote is refused
  too: `x402.memo` is the scheme's key, not the payer's namespace, so an unquoted
  transfer must carry none — a payer naming its own order there would otherwise
  be credited against it. Note that the wallet SDK's own `memo` parameter
  writes a different key (`splice.lfdecentralizedtrust.org/reason`), so both can
  be present without either standing in for the other.

  **The decoder learned two wire shapes it was skipping.** A Daml `Time` is a
  protobuf SFIXED64 — wire type 1, eight little-endian bytes — not a varint and
  not length-delimited, so a reader that only handled wire-type-2 members read
  the deadline back as absent. `TextMap` is now read too, and a repeated
  `x402.memo` is refused rather than resolved: two entries are two answers to
  what the payer committed to, and any last-wins rule lets a producer show one
  value to a reader and another to the engine.

  **Middleware.** `executeBeforeSeconds` is a new option defaulting to 120; `memo`
  is a new option with no default, because quoting one binds it and an invented
  memo would refuse honest payments.

  There is also a new optional `preSettle` hook, because Rule 12 on its own
  proves less than it looks: it compares the transfer against the requirements
  the PAYER echoed, so a payer can echo no memo and sign none, or echo another
  order's memo and sign that — either way the two agree, and the middleware keeps
  no record of what it issued. `preSettle` is where that record goes. It takes
  the payload, the echoed requirements, the `payer` and the verify response, runs
  after verify and before any settle, and returns a reason to refuse (answered as
  a 402 carrying that code) or nothing to accept. Not memo-specific: any check
  needing merchant state belongs there.

  After verify rather than before it, though a refusal is then one round-trip
  dearer. Before verify, the requirements handed to the hook are a payer's claim
  that nothing has yet held against the signed transfer, so a merchant
  reconciling a memo — or reserving stock, or marking an order claimed, which is
  what this hook is for — would be acting on an unverified value. It is also the
  only point at which `payer` exists, the payload having stopped carrying one.
  Wrong scheme, payee, resource or amount are still refused by policy before any
  verify, and verify moves no funds; settle does, and a refusal precedes it.

  Found in review by @dimartiro.

  **Payer.** `CantonX402Payer` now sets the transfer's expiry from the quoted
  horizon. Left unset the wallet SDK picks 24 hours, which would make the
  merchant's horizon decorative and Rule 10 pass on every payment regardless.

  The golden canonicalization vector moves again, regenerated from the
  facilitator's own canonicalizer and checked against it.

  **`nonce` and `validBefore` are gone.** `extra.memo` takes the role `nonce`
  actually had: the merchant's order or payment id, used to reconcile and to
  refuse a replay early. It does the job better, because Rule 12 binds it into
  the transfer the payer signed — `nonce` only ever rode along in echoed
  requirements, outside the signature. It is optional, so a merchant that wants
  neither simply quotes none; the spec's own replay guard is on-ledger and needs
  no off-chain key:

  > Once the transfer executes, those holdings are consumed; resubmitting the same
  > payload references already-spent holdings, which the ledger rejects. The replay
  > guard is therefore native and on-ledger — no off-chain deduplication store is
  > required.

  `validBefore` goes with it, and nothing replaces it: a quote no longer expires
  on its own. The deadline that decides is `executeBefore`, inside what the payer
  signed, which Rule 10 enforces. The trade is that a 402 issued long ago can
  still be paid at the price it quoted, so a merchant whose prices move should
  re-quote rather than rely on the protocol to stale them out.

  That removes `requirements_expired` (nothing can produce it), `isExpired`, and
  the middleware's `validForSeconds` and `nonce` options. `nonce_replayed`
  remains — the guard still exists, it just keys on the memo now.

  The facilitator keys its settlement store on `requirements.nonce` today and
  will need the same change; its replay column and the four migrations that touch
  it move with it.

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

- 44948df: **Breaking.** `PaymentRequirements` drops `resource` and `description`, the last
  two fields it carried that the spec does not define (#76, item 7).

  ```diff
    "payTo": "merchant::1220…",
  - "resource": "https://api.example.com/paid",
  - "description": "Access to /paid",
    "maxTimeoutSeconds": 60,
  ```

  x402 v2 names the resource once, in `PaymentRequired`, and lets a payment echo
  it in `PaymentPayload.resource`. It is not a property of one way to pay, and
  repeating it per `accepts[]` entry invites entries that disagree about what is
  being sold. Every registered Canton facilitator already omits both: the live
  `accepts[]` entries from `facilitator.ftptech.xyz`'s merchants carry `scheme`,
  `network`, `amount`, `asset`, `payTo`, `maxTimeoutSeconds` and `extra`, and
  nothing else.

  Both landed in `PaymentRequired` with #109, so nothing is lost on the wire —
  this removes the second copy.

  **Middleware.** `resource` and `description` stay where a merchant writes them,
  on the terms, and are resolved once into the 402's top-level `resource`.
  `buildQuotes` returns `{ resource, quotes }` rather than a bare list, which is
  the spec's own shape.

  A builder can no longer name the resource by putting it on a requirement, so it
  gains a slot:

  ```diff
  - requirements: (req) => [requirements]
  + requirements: (req) => ({ resource: "https://merchant.example/report", accepts: [requirements] })
  ```

  A builder returning a bare array still works and leaves the resource implicit —
  the request URL, as before.

  **The resource check moved, and is weaker than it read.** `policy.ts` compared
  the echoed `requirements.resource` against the merchant's, under a comment
  saying it stopped a payment minted for path A being replayed against path B.
  It did not. The echoed requirements are payer-supplied and unsigned, and the
  signed transfer encodes the amount, payee, instrument, deadline and memo —
  never the resource — so a payer replaying a payment need only write path B's
  URL into what it echoes. The rule caught a client that re-sent path A's
  requirements verbatim, which is a bug, not an attack.

  The check now reads `PaymentPayload.resource`, the spec's own slot and the only
  resource a payer sends. It is optional, so a payment naming none is accepted
  and one naming another resource is `policy_resource`. The strength is unchanged
  — echo fidelity — and a test now records that limit rather than overstating it.
  What actually ties a payment to one challenge is `extra.memo`: Rule 12 puts it
  inside the signature, and only the merchant's own records can say whether it is
  one they issued, which is what `preSettle` is for.

  **The payer echoes it, and now reads the 402 the way the transport defines.**
  `X402Payer.authorize` takes a second argument, `PaymentContext`, carrying the
  `resource` the 402 named; `CantonX402Payer` puts it on `PaymentPayload.resource`
  and omits the field when given none. A payer implementation that ignores the
  argument still satisfies the interface.

  Supplying it meant reading the 402's envelope, which exposed a separate bug:
  `createX402Fetch` read `accepts[]` from the response **body**. The HTTP
  transport makes `PAYMENT-REQUIRED` the canonical location and calls the body a
  server implementation concern — and every registered Canton merchant answers
  with a 2-byte `{}` body. `api.cctools.network`, `x402.meridiant.xyz` and
  `api.appsfactory.cc` all do. So this wrapper silently declined to pay all of
  them, returning the 402 untouched. It now reads the header first and falls back
  to the body, which this SDK's own middleware sends as well.

  New in `@chainsafe/x402-core`: `decodePaymentRequiredHeader`, the counterpart of
  `encodePaymentRequiredHeader`, with the same depth cap and envelope checks the
  payment decoder has — and, like it, scheme-agnostic. It validates the envelope
  (x402 v2, a `resource` with a `url`, an `accepts[]` of entries carrying the
  fields every scheme's requirements share) and leaves per-scheme judgement to
  the payer, which asks it per entry through `supports()`. Reading each entry as
  canton-exact would throw a mixed-scheme 402 out over an entry the reader was
  never going to pay, leaving it nothing to pay with.

  `isX402PaymentRequiredResponse` and `X402PaymentRequiredResponseEnvelopeSchema`
  are exported for that check; `isCantonPaymentRequiredResponse` stays for a
  caller that does want the strict canton-exact read.

  **`requirementsHash` changes for every payment**, because the canonical form
  lost two fields. The golden vector is regenerated and checked against the
  facilitator's own RFC 8785 canonicalizer, which produces the same bytes:

  ```
  {"amount":"100000000","asset":"CC","extra":{…},"maxTimeoutSeconds":60,
   "network":"canton:devnet","payTo":"merchant::1220dead","scheme":"exact"}
  7ce2010798b65d3c3082b29a8e1071a96191457a844cac4330aa662f4ca9fb54
  ```

  The facilitator reads the hash from `@chainsafe/x402-core` rather than
  canonicalizing its own requirements, so it follows by upgrading — but any
  vector pinned on its side moves with this release.

  `CantonPaymentObjectRequest` and `CantonPaymentObjectResponse` keep their
  `resource`: `/payment-object` is a different endpoint with its own schema, and
  nothing in #76 touches it.

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

  Not included, and still divergent from the spec: `resource` and `description`,
  which the spec puts on PaymentPayload.

- dc43ab7: **Breaking.** `extra.synchronizerId`, which the Canton scheme spec requires and
  we did not send.

  ```diff
    "extra": {
      "assetTransferMethod": "transfer-factory",
  +   "synchronizerId": "global-domain::1220be58c29e",
      "instrumentId": { "id": "Amulet", "admin": "DSO::1220…" },
      "executeBeforeSeconds": 120
    }
  ```

  Scope 6 of #76. The network id stopped carrying the synchronizer when it became
  a name, so there was nowhere left for it to travel: a payment landed on
  whatever domain the payer's participant happened to prepare against, which need
  not be one the merchant settles on.

  The payer now prepares against the quoted one, and the verifier pins the
  transaction's signed `Metadata.synchronizer_id` to it. That field is inside the
  block the signature covers, so it is the payer's commitment rather than a
  relay's choice.

  A mismatch answers **`invalid_exact_canton_synchronizer_mismatch`**, new in
  core, with `transfer_mismatch` in `extensions.reason` and `synchronizer` in the
  detail — the shape every other mismatch already uses.

  The scheme spec names `extra.synchronizerId` but defines no rule for it and so
  no code, so this one is ours. In the scheme's own family rather than borrowed
  from the protocol's, for two reasons. `invalidReason` is the slot a client
  written against the scheme matches on, and the first cut put `transfer_mismatch`
  there — a protocol-level code of ours, which no such client matches and which
  `extensions.reason` was already carrying. And the obvious substitute,
  `invalid_network`, already answers Rule 1's quoted-network check: one code for
  two different failures tells a client less, not more.

  `invalid_exact_canton_synchronizer_mismatch` is **our own code, not the
  spec's**, and stays ours until an upstream rule for `extra.synchronizerId`
  lands. Core keeps it in its own `CANTON_EXACT_EXTENSION_REASONS` list so
  `SPEC_REASONS` stays the spec's table and nothing else; both are spread into
  the picklists, so the wire union is unchanged. Proposing the rule upstream is
  separate work.

  `MISMATCH_REASON` is typed to the spec's codes plus that one extension
  (`SpecVerifyInvalidReason | CantonExactExtensionReason`, both new in core)
  rather than to every code a response may carry, so reaching for one of our
  protocol-level codes in that slot is a build error rather than something to
  catch in review.

  **One thing the pin cannot do on its own.** It runs in the facilitator's
  `/verify`, and the scheme spec mandates no synchronizer rule — so against a
  conformant facilitator that implements only the spec's thirteen rules, the
  signed transfer's domain goes unchecked. The middleware's own
  `policy_synchronizer` compares the payer's ECHOED value against the quote, and
  both of those are unsigned. The binding is real against a facilitator that
  implements this check and advisory against one that does not.

  ### Logical in, physical out

  The part worth reading, because the obvious implementation is wrong.

  `prepare` takes the **logical** id, `global-domain::1220<fingerprint>`, and
  refuses the physical one — yet the bytes it returns carry **either** form,
  depending on the Canton release. Newer ones sign the **physical** id: the
  logical one plus `::<protocol-version>-<serial>`, both the synchronizer's own
  rather than anything a participant picks. LocalNet signs the logical form, so
  the pin has to take both.

  ```
  quoted:  global-domain::1220be58c29e
  signed:  global-domain::1220be58c29e::35-2
  ```

  So the merchant quotes the logical id and the pin accepts either it exactly, or
  it followed by a strict `::<n>-<m>`. That is not a weakening: the `1220…` is the
  domain's namespace fingerprint, so `<quoted>::<n>-<m>` is provably the same
  domain at another version and serial. Another name, another fingerprint, a
  non-numeric or three-part suffix, or any trailing text is refused, and a
  transfer naming no synchronizer counts as a mismatch.

  An exact-equality pin would have refused every honest payment. The mutation
  that reduces the rule to equality fails the test that covers it.

  ### Where the value comes from

  `GET /v2/supported` already advertises it, as `extra.synchronizerId` of the
  kind being quoted, so a merchant that discovers its deployment gets it for
  free. Only a merchant that pins **both** `network` and a whole `asset`
  discovers nothing, and that one must name `synchronizerId` on the way to pay —
  it fails loudly rather than quoting a domain nobody chose.

  The middleware compares the echoed value against its own, as `policy_synchronizer`:
  a payer that echoed another would otherwise have the verifier pin the transfer
  to that instead.

  **`requirementsHash` changes for every payment**, the canonical form having
  gained a field. The golden vector is regenerated and checked against the
  facilitator's own RFC 8785 canonicalizer, which produces the same bytes:

  ```
  d49b82dc50e5d6a80742d88a6f9f4972c7e7eb6bd50869cdda1c080d1e749e5c
  ```

  `PreparedTransaction.metadata` is now read, so a transaction carrying two of
  them is refused rather than having one silently win: two metadata blocks are
  two answers to which domain the payer committed to.

- 11f8910: **Breaking.** `PaymentRequirements` carries the two fields the spec requires of
  every 402 and we left out: a `maxTimeoutSeconds` at the top level and
  `extra.assetTransferMethod`.

  ```diff
    "payTo": "merchant::1220…",
  + "maxTimeoutSeconds": 60,
    "extra": {
  +   "assetTransferMethod": "transfer-factory",
      "instrumentId": { "id": "Amulet", "admin": "DSO::1220…" }
    }
  ```

  `maxTimeoutSeconds` is how long the client has to complete payment. The base
  spec lists it Required for every scheme; ours was `v.optional(v.number())` and
  nothing ever set it. It is now required and read as a duration rather than as
  any number — `v.number()` already refuses `NaN` but admits `Infinity`, `0`,
  negatives and fractions, and none of those is a time a client can be given.

  `extra.assetTransferMethod` is a reserved protocol key, which the spec says to
  interpret as defined rather than as opaque scheme data, so a value other than
  `"transfer-factory"` is refused instead of passed through. Canton's `exact`
  defines exactly one, exported as `ASSET_TRANSFER_METHOD`.

  Both are also on the requirements _envelope_. Leaving the envelope alone would
  have made the narrowing guard the stricter of the two, which is the inversion
  the previous release fixed for the string fields.

  The express middleware fills both in, so a merchant that states neither keeps
  working. `maxTimeoutSeconds` is a new option, per request like the others, and
  defaults to 60 — the value both specs use in their examples. It is advisory:
  nothing refuses a payment for exceeding it.

  The golden canonicalization vector moves, since the hash covers every value.
  Regenerated from the facilitator's own canonicalizer and checked against it:
  `maxTimeoutSeconds` is the first number in that fixture, so it now pins number
  formatting across the two implementations as well.

- deeae58: Verification refuses with the error reason codes the specs define.

  `invalidReason` is now the Canton `exact` scheme spec's code, the one a client
  written against the spec matches on: `invalid_exact_canton_amount_mismatch`
  rather than `transfer_mismatch` with detail `amount`, and so on. The code it
  answered with before moves to `extensions.reason`, and `extensions.detail`
  still names what diverged.

  | before                                                                                                                                                                                                                    | now                                                                                                          |
  | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
  | `scheme_mismatch`                                                                                                                                                                                                         | `unsupported_scheme`                                                                                         |
  | `network_mismatch`                                                                                                                                                                                                        | `invalid_network`                                                                                            |
  | `internal_error`, for another `x402Version`                                                                                                                                                                               | `invalid_x402_version`                                                                                       |
  | `internal_error`, for requirements that are not canton-exact                                                                                                                                                              | `invalid_payment_requirements`                                                                               |
  | `internal_error`, for a missing `preparedTransaction`, `preparedTxHash` or `signature`; `missing_public_key`, for a missing key                                                                                           | `invalid_exact_canton_missing_proof`                                                                         |
  | `internal_error`, for a payload that is not canton-exact (an empty hash or signature included) or a hashing scheme other than V2; `invalid_prepared_transaction_structure`; `transfer_mismatch` with detail `undecodable` | `invalid_exact_canton_malformed_payload`                                                                     |
  | `bad_signature`, `bad_fingerprint`, `prepared_transaction_hash_mismatch`; `missing_public_key`, for a key that is not one                                                                                                 | `invalid_exact_canton_signature_invalid`                                                                     |
  | `transfer_mismatch` with detail `amount` / `receiver` / `instrument` / `memo`                                                                                                                                             | `invalid_exact_canton_amount_mismatch` / `_merchant_mismatch` / `_instrument_id_mismatch` / `_memo_mismatch` |
  | `transfer_expired`                                                                                                                                                                                                        | `invalid_exact_canton_expired`                                                                               |

  The verifier registry answers an unregistered pair with `unsupported_scheme`,
  or `invalid_network` when it has the scheme on other networks, with
  `scheme_mismatch` in `extensions.reason` either way, as before.

  `VerifyInvalidReason` and `SettleErrorReason` take every code the scheme spec
  and the x402 v2 spec define, and keep the older ones, so an answer from a
  facilitator on an older core still parses. Dropping those is a separate change.

  The Express middleware passes `invalidReason` through as the 402's `error`, so
  a merchant that matches on it, or on `onReject`'s `reason`, sees the new codes.
  The older one is in `onReject`'s `extensions.reason`. The middleware's own
  refusal of a transfer it cannot decode now says
  `invalid_exact_canton_malformed_payload` too.

### Minor Changes

- faa61e2: A 402 now carries the spec's `PaymentRequired`.

  `@chainsafe/x402-express` sends it base64-encoded in a `PAYMENT-REQUIRED`
  header, where the x402 v2 HTTP transport puts it, and adds its top-level
  `resource` to the body: the URL and description the requirements were quoted
  for, the same values each `accepts[]` entry carries. The body keeps its other
  fields, `details` included, so existing clients keep working.

  **Breaking, in core:** `X402PaymentRequiredResponse` and
  `CantonPaymentRequiredResponseSchema` require `resource`, a `ResourceInfo` with
  a `url`, as the spec does, and take an optional `extensions`. New:
  `encodePaymentRequiredHeader`, and `isCantonPaymentRequiredResponse` to check a
  402 against the schema.

- c6f8756: The payment travels in `PAYMENT-SIGNATURE`, the header the x402 v2 HTTP
  transport names for it.

  - `@chainsafe/x402-express` reads `PAYMENT-SIGNATURE`, and falls back to
    `X-PAYMENT`, the name this SDK used before, when it is absent or empty. A
    request carrying both is read from `PAYMENT-SIGNATURE`. The fallback is for a
    payment of this release's shape sent under the old name: a 0.1.x payer sends
    the older shape, which is refused either way.
  - **Breaking, in `@chainsafe/x402-server-sdk`:** `createX402Fetch` sends the
    payment in `PAYMENT-SIGNATURE` only, not in both, since a second copy would
    double a header of about 10 KB. A merchant on this release's middleware reads
    it. One on an older middleware could not read this release's payment shape
    anyway.
  - `@chainsafe/x402-core`'s codec errors say "payment header" rather than
    `X-PAYMENT`.

  The docs carry the scheme spec's size guidance: every server and proxy on the
  way should accept at least 16 KiB for this header, and nginx's default refuses
  any single header over 8 KiB.

- 9e66c86: Configure the middleware from the facilitator, fix what a second advertised
  quote — or a successful payment — used to do, and stop the flow being
  canton-shaped.

  ```diff
    requirements: {
  -   network: "canton:devnet",
      payTo: "merchant::1220…",
  -   asset: { instrumentId: { id: "Amulet", admin: "DSO::1220…" } },
  +   asset: "Amulet",
      amount: "500000000",
    }
  ```

  `network` is now optional and `asset` takes an instrument id. `asset` itself
  stays required — `amount` is atomic units of something — but naming it by id is
  enough, and the rest is read from the facilitator's `/v2/supported`: the
  network it settles, and the registry party it validates holdings against. That
  party is the one the facilitator checks a payment against, so reading it from
  there removes the second copy that had to be kept true by hand when a
  deployment moved. Pin `network` and pass the whole `AssetSpec` to skip the
  lookup entirely — a test asserts `/v2/supported` is never called then. An
  `AssetSpec` on its own still reads it, for the network, narrowed to the
  instrument it pins.

  Note the id, not the symbol: Canton Coin is `"Amulet"`, and `"CC"` is what goes
  on the wire. It is the one instrument where the two differ, and an id the
  deployment does not carry is refused with the ids it does.

  A facilitator settling more than one network is an error rather than a guess,
  because a price means nothing without knowing which chain it settles on. Name
  one with `network`.

  ### One resource, a list of ways to pay

  `requirements` is the merchant's terms, not one quote beside some extras:

  ```diff
    requirements: {
      payTo: "merchant::1220…",
  -   amount: "500000000",
  +   resource: "https://merchant.example/report",
  +   accepts: [
  +     { amount: "500000000", asset: "Amulet" },  // 0.05 CC
  +     { amount: "250000", asset: "USDCx" },     // priced separately
  +   ],
    }
  ```

  That is the shape x402 v2 §5.1.2 defines: `PaymentRequired` names ONE resource
  and lists the ways to pay, and `PaymentRequirements` carries no resource of its
  own. `additionalAccepts` is gone with the asymmetry it existed to paper over —
  it took finished requirements, so those entries got no discovery, no defaults
  and no per-challenge reference, and the merchant hand-wrote the registry admin
  that discovery exists to supply.

  Now every entry is a spec. Each gets discovery and a minted `memo` — one
  between the entries that share a generator, a 402 being one sale — the shared
  fields are named once and all but `resource` and `description` are overridable
  per entry, and no entry is privileged. A builder returns the whole list: `(req) => CantonPaymentRequirements[]`.

  ### Every way to pay says what it is priced in

  `asset` is required on every `accepts[]` entry, as an instrument id or as a
  whole `AssetSpec`.

  `amount` is atomic units of _something_, and an entry that left the asset to
  the facilitator's list meant 0.05 CC against a deployment settling Amulet and
  0.05 USDCx against one settling USDCx — the same config, a different sale.
  Worse, two entries could resolve to the same instrument at different prices,
  which a payer settles by taking the cheaper, and a facilitator settling two
  instruments made every request a 500 rather than only the ambiguous entry.

  Naming it by id does not skip discovery: the registry `admin` still comes from
  `GET /v2/supported`, which is the point — that party is what the facilitator
  validates holdings against, so there is no second copy to keep true. Only
  `network` and a whole `AssetSpec` together skip it.

  Either form narrows discovery to the instrument it names. A pinned `AssetSpec`
  used not to, so the richer form did less than the plain id: against a
  facilitator settling two instruments, `asset: "Amulet"` quoted and
  `asset: { instrumentId: … }` failed as ambiguous. Found in review by
  @dimartiro.

  The network can still be ambiguous, and still is an error rather than a guess:
  a facilitator settling the instrument on two networks needs `network` naming
  one.

  **And no two entries may name the same asset.** Two ways to pay in one asset
  leave a payer nothing to choose on but price, so the dearer can never be paid.
  `paymentRequired()` throws when the route is mounted — this is merchant config,
  not anything a request changes, so it fails at startup rather than answering
  500 to every request. Naming an asset by id and pinning the equivalent
  `AssetSpec` are caught as the same asset. An entry whose `asset` is a
  `(req) => …` resolver cannot be read without a request and is not checked.

  An empty `accepts` throws there too, for the same reason — it was a 500 per
  request before.

  Schemes say what distinguishes their own entries, through the new optional
  `SchemeAdapter.distinctKey`.

  Found in review by @dimartiro.

  ### One way to pay that cannot be quoted no longer takes the others with it

  Quotes are built before verify, and building was all-or-nothing: an entry the
  facilitator could not answer for — an instrument it stopped carrying, say —
  turned the whole route into 500s, **paid requests included**. A payer holding
  good terms for another entry was refused while trying to pay.

  Each entry is now resolved on its own. One that cannot be quoted is left out of
  the 402 and the rest are offered; a payment for one that quoted is unaffected.
  Only when NO entry can be quoted does the request fail, since there is then
  nothing to answer with.

  That failure keeps the status the cause deserves. Resolving entries separately
  gave each its own error, and several of them were wrapped in one plain `Error`
  — so a `/v2/supported` outage answered `502` on a route offering one way to
  pay and `500 x402_middleware_error` on a route offering two, telling a client
  the merchant was broken when the facilitator was down. When every failure is a
  `FacilitatorError` it is one cause with several witnesses, and the first is
  rethrown as it came. Unrelated failures still report together, each named with
  its entry. Found in review by @dimartiro.

  `onQuoteError` is the new optional hook that says so, naming the entry and the
  reason, because nothing else would: the 402 simply has fewer entries. It fires
  once per dropped entry per request and a throw from it is swallowed, as with
  `onReject`.

  **A merchant's own mistake is never skipped.** A malformed `amount`, an empty
  `accepts`, two entries in one asset — those are config, they throw as
  `TermsError`, and dropping the entry would hide the typo instead of reporting
  it. Only a failure to quote against the facilitator is skipped.

  A facilitator that starts advertising a second **network** remains a hard
  failure rather than a skip: it makes every entry ambiguous at once, so there is
  nothing left to serve, and picking a chain the merchant did not name would be
  worse than refusing. Pin `network` to settle it.

  Found in review by @dimartiro.

  **`onReject` names the payment it is about.** `PaymentRejectionInfo` gains an
  optional `payment` — the payload, the requirements as `preSettle` received
  them, and the payer. `preSettle`'s docs invite reserving stock or marking an
  order claimed, and settle can fail afterwards; before this there was no way to
  tell which order to release short of decoding the header out of `req` again.
  `PaymentRejectionInfo` is generic over the scheme's types now, defaulting to
  canton-exact's.

  It is attached at ONE point, once `preSettle` has accepted, which is where an
  undo starts being owed. The first cut attached it as soon as the shape checks
  passed, and that was a hole: until verify has held the requirements against the
  signed transfer they are whatever the header claimed, so an underpriced payment
  echoing a reference the merchant issued to someone else handed `onReject` that
  reference, and a merchant following the README released an order a different
  payer was paying for — at no cost to the sender, the payment never settling. A
  refusal before that point now carries `reason` and `details` and no `payment`.
  Documented too: a 502 from a settle that threw may mean the answer was lost
  rather than the payment, so an undo there is a choice about which way to be
  wrong. Found in review by @dimartiro.

  **One reference per challenge, not one per way to pay.** A reference generator
  may book an order, and a 402 is one sale however many ways it offers to pay for
  it. Minting per entry booked N and was paid for one, with nothing in the
  generator's arguments — it is given only `req` — to tell the entries apart.
  Entries carrying the same generator now share the reference it mints, so a
  two-entry 402 books one order and whichever way the payer picks reconciles
  against it. Schemes say which quotes share through the new
  `SchemeQuote.referenceKey`.

  **And the shared terms take a scheme's optional fields, so that is writable.**
  Sharing is by function identity, and `memo` was a per-entry field: the natural
  way of writing it — the same body in each entry — is two functions, so it still
  booked two orders. A merchant could get one only by hoisting the function into
  a variable, which nothing said and the type could not express.

  A scheme's own fields may now be named once beside `payTo` — `memo` is the one
  that needs it — and an entry naming its own overrides it and gets its own
  reference, which is the merchant asking for one. `RequirementsSpec` is the
  mirror of `AcceptSpec` now: an entry must carry the scheme's fields and may
  override the shared ones, so the terms carry the shared ones and may default
  the scheme's. It is an intersection rather than an interface for it, since that
  half is computed from the scheme's own spec. `amount` and `asset` stay required
  on every entry, so naming them at the top level does nothing. Found in review
  by @dimartiro.

  **An entry no longer erases a shared term with an explicit `undefined`.**
  `{ payTo: someVar }` where `someVar` is undefined used to wipe the shared
  `payTo`, and `exactOptionalPropertyTypes` is off so nothing caught it. Only keys
  an entry gives a value to override.

  **`resource` and `description` are not per-entry overrides.** A 402 names ONE
  resource (§5.1.2), so entries disagreeing about it would have the envelope
  describe one sale and its entries another. A builder returns finished
  requirements and so can still disagree; it is refused when it does, rather than
  the envelope quietly taking the first entry's.

  Found in review by @dimartiro.

  ### Three fixes

  **A successful payment no longer mints a second merchant reference.** The `memo`
  generator is documented as once per challenge and may record an order, but it
  ran whenever requirements were built — including on the paid request that
  completed the sale, booking a second order for it. It is now called only when a
  challenge is issued.

  **A payer can pay the second way to pay, not just the first.** The echoed
  requirement was held against the first quote alone, so paying an advertised
  alternative was refused as if it undercut the price. The middleware now works out which
  advertised quote a payment is for and holds it against that one; when a payment
  matches none, the reported reason comes from the quote it got furthest through.

  **Policy comparison is derived from a schema, not hand-kept.** Each field is
  classified exactly once in a table keyed off the schema's own entries — the
  common fields in the middleware, `extra` in the scheme adapter — so a field
  added to either fails the build until someone decides what comparing it means.
  The previous hand-written list silently ignored anything nobody remembered to
  add.

  Two consequences of that table: `extra.executeBeforeSeconds` is now compared,
  refused as `policy_execute_before`, and `description` is deliberately not, since
  it does not reach the ledger.

  That comparison is echo fidelity, not a bound on the deadline. The payer folds
  the value into the transfer's absolute `executeBefore`, and the verifier checks
  only that the deadline is still ahead of now — with no upper bound — so a
  transfer signed much further out than the quote still verifies while echoing
  the quoted number. Closing that means comparing the signed deadline against
  `now + executeBeforeSeconds` with an allowance for clock skew, which is the
  verifier's job and not this change's — tracked in #115. Found in review by
  @dimartiro.

  ### The flow is no longer canton-shaped

  `paymentRequired()` is generic over a **scheme adapter**. It keeps the HTTP flow
  and the fields x402 v2 gives every scheme; the adapter owns `extra` — what goes
  in it, how an echoed one is compared, and where a per-challenge reference lives.

  ```ts
  app.use(
    "/paid",
    paymentRequired<VoucherSpec, VoucherRequirements, VoucherPayload>({
      facilitator,
      scheme: voucherScheme,
      requirements: { payTo: "shop::1", accepts: [{ amount: "10", book: "autumn-2026" }] },
    }),
  );
  ```

  The generic overload requires `scheme`. Without that, a canton call with an
  incomplete way to pay fell through to it, inferred its own `TSpec` from
  whatever it was handed, and compiled — `accepts: [{ amount: "500000000" }]`
  typechecked and then threw `reading 'instrumentId'` at mount. There is nothing
  to fall through to now, so it is a compile error; and for the callers
  TypeScript cannot reach — JavaScript, and a resolver returning nothing — the
  scheme answers with a `TermsError` naming the problem instead of a TypeError
  from two frames down. Found in review by @dimartiro.

  Canton's `exact` is the default (`cantonExact`) and nothing changes for a
  merchant using it: `paymentRequired` keeps a non-generic overload, so an inline
  requirements object is contextually typed against the concrete canton shapes
  exactly as before. `RequirementsSpec` is the shared terms plus `accepts`,
  generic over the scheme's spec and defaulting to `CantonRequirementsSpec`; one
  entry is an `AcceptSpec<TSpec>`, that spec without the shared terms.

  **A scheme names its own error code for an unreadable payer.** When neither the
  facilitator nor the adapter can say who paid, the refusal carries
  `SchemeAdapter.unreadablePayerReason` — canton-exact's
  `invalid_exact_canton_malformed_payload` — rather than a canton code on every
  scheme. The protocol-level `transfer_mismatch` stays in `extensions.reason` for
  a reader that knows that one and not the scheme's, and is the default for an
  adapter that names none.

  New exports: `SchemeAdapter`, `SchemeQuote`, `SchemeContext`,
  `BaseRequirementsSpec`, `AcceptSpec`, `SharedTerms`, `FieldRule`, `RuleTable`,
  `X402RequestState`, `DEFAULT_MAX_TIMEOUT_SECONDS`, `cantonExact`,
  `CantonRequirementsSpec`, and the `compareQuote` / `sameValue` / `resolve`
  helpers an adapter needs. `Resolvable`, `RequirementsBuilder` and
  `PaymentRejectionInfo` were already exported; the last two change shape.

  **A new guard.** The decoded payment is checked by the scheme before
  anything reads a field off it. The envelope is a loose object — `payload.payload`
  is `{}` as far as it is concerned — so a payload missing the fields the scheme
  needs used to reach `payload.payload.payer` and the facilitator. It is now a
  `402 policy_payload_invalid`, costing no verify.

  That is a deliberate difference from the code this replaces, which let such a
  payload reach the verifier and answered the verifier's
  `invalid_exact_canton_malformed_payload`. Refusing it here is earlier and
  cheaper, and the scheme's guard is the only thing that has checked the payload
  at that point; the verifier's code still answers when a transfer decodes but
  does not hold up.

### Patch Changes

- Updated dependencies [90ffd99]
- Updated dependencies [39925bd]
- Updated dependencies [e86b4fb]
- Updated dependencies [0848beb]
- Updated dependencies [ffa5dd2]
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
  - @chainsafe/x402-client@1.0.0

## 0.2.0

### Minor Changes

- 067d870: Verify rejections now forward the facilitator's `extensions.detail` as `details` in the 402 body, as settle rejections already did. New opt-in `onReject` option reports every rejected payment (402) and facilitator/middleware failure (502/500), including the facilitator's full `extensions`, so merchants can log why a payment failed.

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
