# @chainsafe/x402-core

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

- 9fa4ffb: **Breaking. The published API surface is now a deliberate list: 142 names down
  to 108.**

  Until now the surface was a side effect of which files happened to be
  `export *`-ed, so roughly half of what the package published had never been
  chosen by anyone. The next release is 1.0.0, after which every published name
  is frozen for the whole major — so each one is now a decision, and CI fails if
  the build stops matching `packages/x402-core/api-surface.txt`. It compares every
  `export` statement in the built declarations, and separately checks that each
  name not marked `type` is really exported by the built ESM and CJS — a name can
  be demoted to type-only without the declarations moving at all.

  ### If you used one of these

  **Validation schema objects** — `VerifyRequestSchema`,
  `VerifyResponseValidSchema`, `VerifyResponseInvalidSchema`,
  `SettleResponseSuccessSchema`, `SettleResponseErrorSchema`,
  `SupportedKindSchema`, `SupportedInstrumentSchema`, `CantonSupportedExtraSchema`,
  `AssetSpecSchema`, `InstrumentIdSchema`, `PaymentExtensionsSchema`,
  `ResourceInfoSchema`, `CantonPaymentInnerSchema`, `CantonPaymentPayloadSchema`,
  `CantonPaymentRequiredResponseSchema`, `CantonPaymentRequirementsSchema`,
  `CantonRequirementsExtraSchema`, and the three `X402Payment*EnvelopeSchema`.

  → **Eight have an `is*` guard**, unchanged, and so is the type: use
  `isCantonVerifyRequest`, `isCantonPaymentInner`, `isCantonPaymentPayload`,
  `isCantonPaymentRequiredResponse`, `isCantonPaymentRequirements`,
  `isX402PaymentPayload`, `isX402PaymentRequirements` and
  `isX402PaymentRequiredResponse`.

  → **The other twelve have no guard** — `VerifyResponseValidSchema`,
  `VerifyResponseInvalidSchema`, `SettleResponseSuccessSchema`,
  `SettleResponseErrorSchema`, `SupportedKindSchema`, `SupportedInstrumentSchema`,
  `CantonSupportedExtraSchema`, `AssetSpecSchema`, `InstrumentIdSchema`,
  `PaymentExtensionsSchema`, `ResourceInfoSchema` and
  `CantonRequirementsExtraSchema`. These are the parts the larger validators are
  assembled from, not messages anything receives on its own. Their **types stay
  published**: validate at the level that has a guard and use the type for the
  part. If you were validating one of them standalone, say so — a guard is an
  addition, not a breaking change, which is why none is published on spec.

  The rule applied throughout is: publish the type always, publish the runtime
  object only where it is the single reachable way to do something the type cannot
  _and_ the thing is received whole. Two cases qualify and remain public — the
  **picklists** `VerifyInvalidReasonSchema` and `SettleErrorReasonSchema`, where
  the object _is_ the enumerable list of codes, and the **whole-response
  validators with no `is*` twin**, `VerifyResponseSchema`, `SettleResponseSchema`
  and `SupportedResponseSchema`.

  Core's declarations no longer import valibot. It was only a devDependency, so
  for anyone without it every schema-derived type (`SettleResponse`,
  `CantonPaymentRequirements` and the rest) resolved to `any` under
  `skipLibCheck`. `dts: { resolve: ["valibot"] }` now inlines valibot's types
  the way `noExternal` already inlines its code.

  That does not take valibot out of the API. Those types are still inferred from
  valibot schemas, and the five schema objects above are valibot values, so a
  valibot major in core can still be breaking for both.

  **The `parse*` functions** — `parseCantonPaymentInner`,
  `parseCantonPaymentPayload`, `parseCantonPaymentRequirements`,
  `parseCantonVerifyRequest`, `parseX402Request`.

  → Use the `is*` guards. The parsers threw valibot's `ValiError`, which made the
  validation library part of the contract. If you need a _reason_ rather than a
  boolean, say so — a core-owned error type can be added without a breaking
  change, whereas removing these later could not.

  **`CantonPaymentObject`, `CantonPaymentObjectRequest`,
  `CantonPaymentObjectResponse`** and the `DisclosedContract` pair are **deleted**,
  not merely unexported. No x402 specification defines `POST /payment-object`, the
  facilitator removed it as unused, and `CantonPaymentObject` carried
  `facilitatorFee` / `totalAmount` — a fee structure still being designed, which
  1.0.0 would have frozen wrong.

  **`findTransferMismatch` and `MAX_PAYMENT_DEPTH`** are internal now: an
  implementation detail of the verifier, and a defensive limit on the
  payment-header codec rather than a protocol value.

  ### One addition

  **`CantonRequirementsExtraKey`** — the union of `CantonRequirementsExtra`'s keys.
  Needed because that type is inferred from a `looseObject`, so it carries an index
  signature and `keyof` on it collapses to `string`; the set of keys was previously
  obtainable only by reading `.entries` off the schema object.
  `@chainsafe/x402-express` uses it for its rule-table drift check and ships in the
  same release.

  ### Kept

  **`encodePaymentResponseHeader`, `decodePaymentResponseHeader` and
  `isSettlementPending`** arrived after this list was drawn. All three are
  published: `@chainsafe/x402-express` writes the `PAYMENT-RESPONSE` header with
  the encoder, so a caller has to be able to read it back, and the guard is how a
  caller tells a pending settlement from a failed one.

- 764a797: **Breaking.** A prepared transaction must submit as the sender, and as nobody
  else.

  `Metadata.submitter_info.act_as` names the parties a submission acts for. It is
  inside the signing preimage — the hasher concatenates it first — so the payer
  chooses it and commits to it. Nothing read it. Nothing in the choice argument
  constrains it either, so a transfer that moved the sender's own money could
  name any party at all as a co-submitter: a stranger, or a facilitator's own
  party.

  It is refused now unless it is exactly the transfer's sender. An empty list is
  refused with it: that is not "no claim", it is a submission with no proven
  submitter.

  **Why it mattered.** `act_as` grants AUTHORITY rather than describing the
  transfer, so none of the checks that bind the transfer could catch it. Verify
  answered valid and the ledger then refused the submission, because the
  facilitator relays only the payer's signature and an unsigned co-submitter is
  unauthorised — a payment the merchant was told was good, in the window between
  verify and settle, free and repeatable. Where a named party is one the
  submitting participant already holds act-as rights over, the submission may
  carry authority nobody inspected instead of failing.

  Refused in the decoder rather than the verifier, as `expectedAdmin` is: two
  signed fields that have to agree is a statement about the blob alone, with no
  requirements involved. `DecodedTransfer` is unchanged — the parties are read
  and checked, not reported.

  Every real MainNet capture available carries exactly one `act_as`, equal to the
  transfer's sender, Canton Coin and registry tokens alike. The reference
  implementation holds the same invariant on every value-moving path, with its
  own empty-list guard added after an empty list once skipped the check silently.

- 39925bd: Breaking: Recompute the canonical Canton prepared-transaction hash during verification, reject signed hashes that do not match the submitted transaction, and bound and validate the transaction graph before hashing. `SchemeVerifier.verify` and verifier-registry verification now return `Promise<VerifyResponse>`.
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
  within five seconds of it, is refused with `invalid_exact_canton_expired`.
  Settling is not instantaneous, so accepting one about to lapse buys the wasted
  relay the rule exists to avoid. An absent deadline counts as expired: a real
  transfer always carries one, and reading a missing field as "no deadline" would
  make the check skippable by leaving it out.

  `invalid_exact_canton_expired` is the only expiry left, and it says something
  narrower than the one it replaces: not that the quote went stale, but that the
  transfer the payer signed can no longer settle, so the client should prepare
  another against the quote it already has.

  **Rule 12, memo.** When the merchant quotes one, the transfer's metadata must
  carry the identical value under `x402.memo`, or the payment is
  `invalid_exact_canton_memo_mismatch`. A memo the merchant did not quote is
  refused too: `x402.memo` is the scheme's key, not the payer's namespace, so an
  unquoted transfer must carry none — a payer naming its own order there would
  otherwise be credited against it. Note that the wallet SDK's own `memo`
  parameter writes a different key (`splice.lfdecentralizedtrust.org/reason`), so
  both can be present without either standing in for the other.

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
  the middleware's `validForSeconds` and `nonce` options.

  **The memo is not the nonce under another name.** It binds in both directions —
  the transfer's `x402.memo` must equal the quoted value — but nothing enforces
  that a given memo is used once. The replay guard keys on the transaction hash
  instead, so it catches the same signed transaction presented twice and not a
  second transaction against the same quote, which the nonce's unique index did.
  A merchant reconciling by memo should know that two settlements can carry the
  same one.

  The facilitator keys its settlement store on `requirements.nonce` today and
  will need the same change; its replay column and the four migrations that touch
  it move with it.

- d39a861: **Breaking. A payment to a party with no `TransferPreapproval` is now refused.**

  If your `payTo` party has no preapproval, Canton Coin does not pay it directly:
  the Token Standard turns the transfer into an offer the party must accept
  before the funds are its own. Until now those payments verified. They are now
  refused with `invalid_exact_canton_preapproval_missing` and
  `extensions.detail: "no_direct_delivery"`.

  **What to do:** make sure every `payTo` party holds a live `TransferPreapproval`
  before upgrading. A merchant running its own validator already has one; a party
  that only ever received offers does not.

  **Why:** a payment that lands in an offer is not a payment. The merchant has
  released the resource, the funds sit where the payer can still withdraw them,
  and nothing in the signed transfer's arguments says which of the two happened —
  only the transaction's consequence nodes do. This is the case the rule exists
  for, and it is the one that costs a merchant real money.

  ### What else is checked

  The delivery node must now also be what it claims. Both arms require the
  exercised contract to be disclosed by the transaction and, for a registry
  token, signed by the instrument's admin — otherwise a payer could append a node
  that merely _names_ a delivery choice and carry a pending tree past the check
  above. The Canton Coin send's own amount is held to the root's, so a dust send
  against a correctly bound preapproval no longer passes. A tree carrying a
  delivery node of the other arm is refused. The legacy
  `TransferPreapproval_Send` is refused, since its argument layout is unmeasured
  and its amount therefore cannot be bound.

  Separately, a contract the **sender** signs must be co-signed by the
  instrument's admin. Such a contract carries the payer's authority into whatever
  choices it offers, exercised later by whoever controls them. Only sender-signed
  creates are constrained; every create in every real capture satisfies it.

  `DecodedTransfer` gains `consequences` (every exercise below the root, with the
  disclosed contract it targets, the transfer it names in its own argument, and
  that argument's scalar leaves) and `creates` (every contract the transaction
  makes). Nothing under a rollback is reported.

  ### Severity of the rest

  Apart from the preapproval case above, these refusals are **verify-passes /
  settle-fails**: the forged tree does not execute. Measured, not assumed — a real
  prepared transaction, tampered and re-signed with the payer's own key, was
  rejected on submission in both shapes tried, against Splice 0.6.0 / Canton 3.4
  LocalNet, with an untampered control committing. They matter to a caller that
  verifies without settling, which is the Express default: it serves a resource on
  `isValid: true` and never learns the payment could not land.

  **Not closed:** a consequence of neither arm. Closing it needs a whole-tree
  allowlist, which is fail-closed and version-coupled — the day Splice adds a
  consequence to the transfer body, every caller refuses honest payments. It is
  left to the ledger, which was measured refusing that shape.

- 02ee930: **Breaking.** A verify refusal no longer carries `extensions.reason`. What it
  carried that was worth keeping — which of a code's causes the refusal was — is
  in `extensions.detail`, where the rest of the causes already were.

  `reason` held the code this verifier answered with before the scheme spec's
  table. For most of the codes it annotated it simply restated them:
  `invalid_network` ← `network_mismatch`, `unsupported_scheme` ←
  `scheme_mismatch`, `invalid_exact_canton_expired` ← `transfer_expired`, and
  `invalid_payment_requirements` ← `internal_error`, which says less than the
  code it explains. Nothing has ever read it — not this repo, not a facilitator,
  not the reference implementation, which types `extensions` opaque and never
  writes a `reason`. The Canton scheme spec does not mention `extensions` at all.

  Where it did carry something, it now says so properly.
  `invalid_exact_canton_signature_invalid` has four causes a payer needs told
  apart, and `detail` names them: `no_payer_key` (the party publishes none this
  facilitator can use), `malformed_encoding` (the hash or signature is not in the
  encoding the spec asks for), `hash_mismatch` (the hash describes a different
  transaction), `bad_signature` (it verifies under none of the party's keys). The
  encoding case used to be labelled `bad_signature`, which it is not — no
  signature is checked there. `invalid_exact_canton_missing_proof` and
  `invalid_exact_canton_malformed_payload` gain `payload_missing`,
  `proof_fields_missing`, `payload_shape` and `unsupported_hashing_scheme` for
  the same reason. A transaction that gunzips but that the schema cannot read (a
  field it does not define, say) is `structure_undecodable`, apart from the
  `undecodable` of a member that will not gunzip; `reason` used to tell those two
  apart as `invalid_prepared_transaction_structure`.

  A refusal whose cause is not in doubt now carries no `extensions` at all,
  rather than one restating the code.

  **For a merchant on `@chainsafe/x402-express`,** `onReject`'s
  `extensions.reason` is gone; `extensions.detail` is what to read.

  ### The older codes are gone too

  `VerifyInvalidReason` typed `fail`'s `extensions.reason` parameter as well as
  the wire field, so most of the older codes in that union were live in the
  extension slot and it could not be narrowed without breaking the verifier.
  With that field gone it types the wire field alone, so both picklists are now
  what something actually answers with — twelve codes leave `VerifyInvalidReason`
  and eleven leave `SettleErrorReason`:

  | removed from          | codes                                                                                                                                                                                                                                                                                      |
  | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `VerifyInvalidReason` | `scheme_mismatch`, `network_mismatch`, `requirements_hash_mismatch`, `bad_fingerprint`, `bad_signature`, `prepared_transaction_hash_mismatch`, `invalid_prepared_transaction_structure`, `missing_public_key`, `transfer_mismatch`, `transfer_expired`, `internal_error`, `nonce_replayed` |
  | `SettleErrorReason`   | `unauthorized`, `scheme_mismatch`, `network_mismatch`, `requirements_hash_mismatch`, `bad_fingerprint`, `bad_signature`, `facilitator_error`, `nonce_replayed`, `bad_request`, `execution_failed`, `timeout`                                                                               |

  **Both lists are now the specs' codes plus one declared extension, and nothing
  else.** Every remaining refusal is expressible in a vocabulary a client written
  against the spec already matches on.

  `internal_error` and `facilitator_error` go because the x402 v2 spec already
  names what they mean: "**`unexpected_verify_error`**: Unexpected error occurred
  during payment verification" and "**`unexpected_settle_error`**: Unexpected
  error occurred during payment settlement" (§9). Both are already in these
  lists. A facilitator answering `internal_error` is telling a spec-written
  client nothing it can match on.

  **The cost, stated plainly.** These codes were kept so an answer from a
  facilitator on an older core would still parse. One carrying a removed code no
  longer validates against core 1.0. Before 1.0.0 was the last chance to do it —
  a picklist can only grow in a minor — which is why it happens here rather than
  later. Nothing validates these at runtime on the client path, so this narrows
  types rather than breaking a live call.

  `nonce_replayed` goes for a different reason: it names a mechanism that no
  longer exists. The requirements stopped carrying a nonce, and the guard is
  keyed on the transaction hash core recomputes from the signed bytes. What it
  refuses is a signed transaction presented twice, which is not what its name
  says.

  Three more settle codes go, each to a code one of the specs already defines:

  | was                | becomes                                                                                                                                      |
  | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
  | `execution_failed` | `invalid_exact_canton_execute_failed` for a definite ledger rejection, the scheme spec's own name for one                                    |
  | `bad_request`      | `invalid_payload` for a malformed body; it was invented, and was never in this list on the verify side where it is also written              |
  | `timeout`          | nothing: since ChainSafe/canton-x402-facilitator#373 an unknown outcome is the non-terminal `settlement_pending`, so no facilitator sends it |

  **A facilitator must migrate six codes,** the ones it still writes. Not all of
  them map one-for-one, because some are used for more than one cause:

  | it writes           | for                                                                          | answer instead                                                                                                                    |
  | ------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
  | `bad_request`       | a malformed body                                                             | `invalid_payload`                                                                                                                 |
  | `internal_error`    | an unexpected fault in verify                                                | `unexpected_verify_error`                                                                                                         |
  | `internal_error`    | the minimum-amount policy (`authorization_amount_too_low`, `invalid_amount`) | `invalid_payment_requirements`: a policy refusal of the quoted amount, not an unexpected error                                    |
  | `facilitator_error` | an unexpected fault in settle                                                | `unexpected_settle_error`                                                                                                         |
  | `execution_failed`  | a definite ledger rejection                                                  | `invalid_exact_canton_execute_failed`                                                                                             |
  | `execution_failed`  | `settlement_currency_unsupported`                                            | `invalid_payment_requirements`: the merchant's configuration is at fault, and `execute_failed` would tell the payer to sign again |
  | `unauthorized`      | a verify `missing_public_key`, mapped onto settle                            | nothing to map: core now answers `invalid_exact_canton_signature_invalid`, which passes through as a settle reason                |
  | `nonce_replayed`    | the same signed transaction presented again                                  | see below                                                                                                                         |

  `nonce_replayed` has no replacement code, because neither spec defines a replay
  refusal. A guard keyed on the transaction hash never sees a merchant reusing a
  reference; what it sees is the same signed transaction sent again, usually a
  retry after `settlement_pending`. The scheme spec's settle section says what
  that retry gets: while the submission is unresolved, the facilitator looks it up
  and answers `settlement_pending` again until it finds the outcome; one found
  rejected, or provably never recorded, is `invalid_exact_canton_execute_failed`;
  one found committed is answered with success once, and any later settle relays
  again and the ledger refuses the duplicate, which is
  `invalid_exact_canton_execute_failed` too. **Do not map it to a requirements or
  payload refusal.** The express middleware answers those with a fresh challenge,
  so a payer whose first transfer may still land would be asked to sign a second.

  That migration has to happen in the same change that adopts this core, which is
  required anyway for `verify`'s new signature — and it has to happen now,
  because after 1.0.0 a picklist member cannot be removed until 2.0.

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

- 265c3ab: **Breaking.** A canton-exact transfer must now spend the payer's own holdings
  of the quoted instrument, and they must cover the amount (spec Rule 13). Until
  now verify never read the inputs, so a transfer that spent nothing, someone
  else's holdings, or less than the amount answered `isValid: true` and failed
  only when the ledger ran it.

  Each refusal answers `invalid_exact_canton_insufficient_inputs`, names the
  payer, and gives one of these as `extensions.detail`:

  - `inputs_none`: `inputHoldingCids` is empty, absent, or not a list of contract
    ids.
  - `inputs_repeated`: an id is declared more than once.
  - `inputs_unresolved`: a declared id is not exactly one of the transaction's
    input contracts, or the contract it names cannot be read: it has no template
    id, its argument is not a record, or a label repeats at any depth of that
    record. It is refused, never skipped, even when the other inputs would cover
    the amount.
  - `inputs_template`: the input is not a holding of the instrument's kind: a
    `Splice.Amulet:Amulet` for Canton Coin, a
    `Utility.Registry.Holding.V0.Holding:Holding` for any other instrument.
  - `inputs_signatories`: its signatories are not exactly the instrument's admin
    and the sender.
  - `inputs_owner`: its `owner` is not the sender.
  - `inputs_admin`: its `dso` (Canton Coin) or `registrar` (registry) is not the
    instrument's admin.
  - `inputs_instrument`: a registry holding's `instrument.id` is not the quoted
    instrument.
  - `inputs_amount`: its amount is not a ledger amount. A Canton Coin holding's
    amount is its `amount.initialAmount`, since a transfer charges no holding fee
    on its inputs (CIP-0078).
  - `inputs_short`: the amounts sum to less than the transfer's.

  Each field is read at its declared type, and by declaration order when a label
  is missing, as the rest of the transfer is. The check runs after the deadline
  (Rule 10), so a payment that is both expired and short answers
  `invalid_exact_canton_expired`.

  **What to do:** nothing, for a payer that builds its transfer through the
  ledger's prepare. That declares and discloses the inputs, and every real
  payment decoded so far passes. A hand-built transaction must declare its
  holdings in `inputHoldingCids` and disclose each one as an input contract.

  **One honest payment is refused.** The wallet SDK's input selection skips a
  `LockedAmulet` only while its lock is live, so it can choose one whose lock has
  expired. Rule 13 names the plain `Amulet`, so that payment is refused as
  `inputs_template`. `CantonX402Payer` cannot avoid this today: it takes
  whatever the wallet SDK selects. A payer that builds its own transfer can pass
  `inputUtxos` to `token.transfer.create`, naming plain Amulets only.

  **Registry tokens** are read against the DA Utility Registry's `Holding`, the
  registry whose transfer rule delivery already requires. Its layout
  (`operator`, `provider`, `registrar`, `owner`, `instrument {source, id,
scheme}`, `label`, `amount`) is known from one real USDCx transfer. If a
  registry's holding differs, its payments are refused with an `inputs_*` detail
  rather than let through.

  **Not checked:** whether an input is still unspent, and whether its disclosure
  is genuine. The disclosure is part of what the payer signs, as the factory's
  is. The ledger authenticates each input against its id and refuses a spent one
  when the transfer executes.

  `DecodedTransfer` gains an optional `inputs`: each declared id with the input
  contract it names, the record's leaves kept at their Daml types. It is absent
  when the transfer declares none.

- e9b6cfb: **Breaking.** The packages need Node 22.2 or later. `engines` was `>=20`.

  Node 20 reached end of life on 2026-04-30. 22 is the oldest line still
  supported, until 2027-04-30, so nobody has to move to the newest Node to use
  the SDK. 22.2 is the first release of 22 with `zlib.crc32`, which the gzip
  codec for the payload's `preparedTransaction` (#75) needs. The codec frames the
  gzip member by hand and checks its CRC32 itself, because `gunzip` accepts the
  concatenated members and trailing bytes that the Canton scheme says to refuse.

  The build target moves from `node18` to `node22` to match.

- 7c8e4d8: **Breaking.** One decoder. The hand-rolled prepared-transaction walker is gone;
  `decodePreparedTransaction` now reads the transaction through
  `@canton-network/core-tx-visualizer` — the same decode the signing hash is
  taken over — and refuses unknown protobuf fields.

  The walker guarded the wrong boundary. Its stated goal was agreeing with
  Canton's protobuf-java, but the payer's signature covers a hash computed from
  the vendor's parse. Strictness applied to a third parser sitting outside the
  hash protects nothing; worse, the requirements were being bound to the walker's
  reading while the signature committed to the vendor's — two readings of one
  blob, where an attacker wins by making them disagree. Deleting it takes three
  parsers to two, and the survivor is the hash's own.

  `decodePreparedTransaction`, `DecodedTransfer` and `MEMO_KEY` keep their names
  and shapes, including the `| null` channel, so no import changes.

  **What is now refused that was not.** The decode runs with
  `readUnknownField: "throw"`, so a prepared transaction carrying a field the
  schema does not define is rejected rather than read past. That is the point: the
  hash cannot cover a field it cannot see, so reading past one meant binding the
  requirements to bytes nobody signed. The hasher refuses the same input.

  **What is now accepted that was not.** A singular SCALAR field written twice,
  or a node carrying two known node types. Protobuf keeps the last of those, and
  so does the decode the hash is taken over — so refusing them was the walker
  disagreeing with the ledger rather than catching anything. Eight tests pinning
  those refusals are removed and one is added in their place, pinning that a
  repeated singular scalar now reads LAST, as the ledger reads it.

  **A repeated MESSAGE field is a different thing, and is refused.** Two copies
  of a message do not last-wins: protobuf merges them, and merging concatenates
  their repeated members. A chosen value written twice therefore decodes as one
  record carrying `expectedAdmin, transfer, expectedAdmin, transfer` — and a
  reader taking the first would bind the requirements to a benign transfer while
  the signature covers a second paying someone else. `fieldsOf` now refuses a
  record whose labels repeat, which a Daml record never does honestly. Only the
  labeled form is caught; a fully-positional record doubled the same way
  concatenates into indices nothing can tell apart, and the ledger's arity check
  is what refuses that.

  **What is kept.** Every structural invariant: exactly one root, the transfer is
  that root, no transfer under a rollback, no duplicate or unreachable nodes. And
  `canonicalNodeId`, moved into `prepared-tx-guard.ts` and applied where a node is
  defined — the one check the hash genuinely does not backstop, since node ids are
  absent from its preimage and the decode keys nodes by raw string, making "0" and
  "00" two nodes here and one at the ledger.

  `prepared-tx-hash.test.ts` gains a test pinning the property this rests on: that
  the hash moves when the decoder's output moves, and refuses what the decoder
  refuses. It did not hold on core-tx-visualizer 1.7.0, so it is pinned rather
  than assumed.

- 476ec71: **Breaking. The payload no longer carries the payer's public key; a facilitator
  reads it from the ledger instead (#105).**

  The spec's `payload` never had a `publicKey`, and ours admitted as much in its
  own comment: it stayed "until the facilitator can read the sender party's keys
  from the ledger". It can now — Canton 3.7's
  `GET /v2/jose/jwks/synchronizer/{id}/party/{party}` returns a party's Ed25519
  keys on the same JSON Ledger API a facilitator already authenticates to.

  ### If you build payloads

  `CantonPaymentInner.publicKey` is gone, and so is `CantonPartyKey.publicKey` —
  it fed only that field. `@chainsafe/x402-server-sdk` drops it from the payloads
  it signs; nothing else is needed, since the private seed is what signs and the
  party id already carries the fingerprint.

  ### If you call the verifier

  `SchemeVerifier.verify` and `VerifierRegistry.verify` take a third argument: the
  scheme's own **context**, the facts a caller must resolve before verifying. For
  Canton `exact` that is `CantonVerifyContext`, `{ payerPublicKeys }` — the payer
  party's PUBLIC signing keys, which the CALLER reads from the ledger. The payer
  is the transfer's sender, which `decodePayloadTransfer` reads without verifying
  anything, so a facilitator decodes, looks the party up, then verifies. Core
  stays synchronous and reads nothing itself.

  A context object rather than a bare array because `SchemeVerifier` is
  scheme-agnostic and another scheme needs other facts. It is generic —
  `SchemeVerifier<TContext = unknown>` — so a registry still holds verifiers for
  different schemes side by side, while a concrete verifier type-checks its own
  callers. Reach for the bare `SchemeVerifier` and the context is `unknown`,
  which accepts anything: name the context type when you hold one verifier.

  ### Which key signed

  A successful verify now answers `extensions.signedBy`: the fingerprint of the
  key the signature actually verified under.

  A Canton submission names one key per signature in `partySignatures.signedBy`,
  and until now a facilitator derived it from the payload's `publicKey`. That
  field is gone, and the payer's `::` suffix is NOT a substitute — it is the
  party's NAMESPACE fingerprint, which equals a signing key's only while the
  party publishes one. A party mid-rotation publishes two, so the suffix can name
  a key that did not sign: verify would pass and the ledger would refuse the
  submission, after the facilitator had already committed.

  Core knows which key verified, because it just searched for it. Handing it back
  costs nothing and keeps one answer to "which key signed" rather than two that
  can drift — which matters here, since Ed25519 validity is encoding-sensitive
  and a second verifier would be free to disagree.

  A list because that is the shape the sources have — a JWKS `keys[]`, Canton's
  `partySigningKeys.keys[]` — and because a party may publish **up to 20** signing
  keys. The payload does not say which one signed, so any of them verifying is the
  party verifying. Passing a party's whole set is correct; passing none refuses
  the payment.

  **Standard base64, not base64url.** Core decodes a key with `atob`, which
  refuses `-` and `_`, while a JWKS serves its `x` as base64url. Roughly three
  keys in four contain a byte that the two spell differently, so passing `jwk.x`
  through unconverted refuses most payments — and refuses them _quietly_:
  `verifySignature` answers false rather than throwing, so an undecodable key is
  indistinguishable from a key that did not sign, and the payer is blamed for a
  bad signature. Convert before calling.

  The keys are NOT narrowed to the one whose fingerprint equals the party's `::`
  suffix. That suffix is the party's NAMESPACE fingerprint, equal to the signing
  key's only for a single-key party, so narrowing would refuse an honest payment
  from a party mid key-rotation. What binds a key to the sender is that the caller
  looked it up BY that party id.

  ### One wire change beyond the field

  A payer whose key cannot be resolved was previously refused at the envelope, as
  `invalid_exact_canton_missing_proof` with **no payer**, because the missing key
  was a missing proof. There is no key in the payload to miss now, so the refusal
  happens after the transfer decodes: `invalid_exact_canton_signature_invalid`,
  **naming the payer**, with `no_payer_key` in `extensions.detail`.
  That matches the reference implementation, which answers `signature_invalid`
  when its own key lookup returns nothing.

  ### Not covered

  A party with a signing threshold above 1 needs more than one signature, and an
  x402 payload carries exactly one. Nothing here reads the threshold, so such a
  payment passes verify and is refused by the ledger at submission. The JWKS route
  does not return the threshold; the participant's admin API does.

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
  the verifier's shape check (`invalid_exact_canton_malformed_payload`, detail
  `payload_shape`).

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

  Verify still checks the signature against the payer's key, and a transfer
  naming another party as sender is refused because that party's keys are the
  ones the signature is checked against.

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
  neither is there, the middleware refuses with
  `invalid_exact_canton_malformed_payload` before settling.

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
  `PaymentRequirements`. Nothing answers `requirements_hash_mismatch` any more,
  and it is not in the reason lists at 1.0.0.

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
  `unsupported_scheme` / `invalid_network`. It compares nothing else in
  `accepted`: the transfer is bound to `paymentRequirements`, as before. A payment
  without a usable `accepted`, including the pre-spec envelope, is
  `unsupported_scheme`, and an `x402Version` other than 2 is
  `invalid_x402_version`. `schemeNetworkMatches` reads
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

- b3a1e29: **Breaking.** The payload's `preparedTransaction` is base64 of one gzip
  member, as the Canton scheme spec defines, instead of base64 of the bare
  protobuf. A typical transfer goes from 22-27 KB to about 5 KB, which keeps
  the payment header near 10 KB.

  The verifier reads it only as exactly one gzip member with no optional header
  fields, at most 8 KiB compressed and 72 KiB decompressed. Concatenated members,
  bytes after the member, bytes between the deflate stream and the trailer, and a
  trailer that does not match are refused, and a decompression bomb stops at the
  bound. Anything else is `invalid_exact_canton_malformed_payload` with detail
  `undecodable`.

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

- 0cafbe5: **Breaking.** A canton-exact transfer must now be exercised through a real
  transfer factory. The payer chooses which contract to exercise, and until now
  nothing looked at that choice — a transfer exercised on a contract the payer
  wrote themselves, exposing a choice named `TransferFactory_Transfer` with
  arguments shaped like the real one, passed every check the verifier made. The
  whole payment reduces to "something called transfer happened", so the rule
  fixes what it happened on.

  The exercised contract id is resolved against the transaction's own disclosed
  input contracts, and the contract it names must be:

  - disclosed exactly once, under a package name, module and entity its own
    disclosure and the exercise agree on (`factory_unresolved` otherwise —
    including when nothing discloses it);
  - exercised through the Token Standard `TransferFactory` interface
    (`factory_interface`).

  Both refuse as `invalid_exact_canton_malformed_payload`, with the cause in
  `extensions.detail`.

  **`expectedAdmin` is held to the instrument's admin.** The choice argument is
  `{ expectedAdmin, transfer }`. The two name different things — `expectedAdmin`
  is the FACTORY's admin, which the Token Standard has the factory validate
  against its own, while `instrumentId.admin` is the registry administering the
  INSTRUMENT — and the standard does not require them equal.

  This requires it. `TransferFactoryView.admin` is "the party representing the
  registry app that administers the instruments for which this transfer factory
  can be used", so a well-formed registry has one party in both, and the real
  Canton Coin payment does — and it is what the standard itself asks for: the
  factory MUST validate `expectedAdmin` against its own admin, so holding it to
  the instrument's admin here puts the ledger at the end of the chain.

  What it buys: `expectedAdmin` is what the ledger guards on, so a facilitator
  that pins the admin to the real DSO pins the guarded field with it, and a
  transfer aimed at another issuer's factory is refused at verify rather than at
  execution — which matters most to a caller that verifies without settling.

  **The interface, not the template.** `TransferFactory_Transfer` is defined on
  `Splice.Api.Token.TransferInstructionV1:TransferFactory`, which each registry
  implements with its own template — Canton Coin with `ExternalPartyAmuletRules`,
  another issuer with its own. Matching Canton Coin's template would refuse every
  other registry's instrument, which this package routes payments to by design.

  **No package id is compared**, against either a constant or the other side of
  the blob. Canton documents that an exercise's `template_id` and its target
  contract's may differ once the contract has been upgraded or downgraded: the
  first names the package the choice resolved against, the second the package the
  contract was created under. Requiring them equal would refuse honest payments
  for the whole window of a Splice rollout. The package NAME is what an upgrade
  preserves, so that is what the two sides must agree on.

  **Who signed the factory is NOT checked.** The Token Standard constrains it
  nowhere — `TransferFactory` is an interface and signatories are an
  implementation's own choice — and real MainNet bytes differ: Canton Coin's
  factory is signed by the DSO, while a Utility Registry transfer exercises the
  MERCHANT's own preapproval, signed by the merchant and not the issuer at all.
  An earlier draft required the admin among the signatories and refused every
  registry payment.

  What ties the factory to the issuer instead is `expectedAdmin`, which the
  standard requires the factory to validate against its own admin. That link is
  the ledger's to enforce, and holds only because vetted packages implement the
  MUST; it cannot be checked from the bytes, so nothing here tries.

  **What this does not establish — two gaps, both real.**

  The disclosure is payer-written: `input_contracts` is part of the blob the payer
  signs, so every field this reads is one the payer chose — the interface the
  choice was inherited from included. What makes the check bite is not this layer
  but the synchronizer,
  which authenticates a disclosed contract against its contract id at submission,
  so a fabricated disclosure never settles. The proof is self-attested here and
  enforced at settlement — a caller that verifies without settling gets no
  protection from it.

  The admin is read from the payment requirements, which the merchant supplies,
  so the rule binds the payer to the merchant's declared issuer rather than to
  Canton Coin itself. Pinning the real DSO needs a value only a facilitator holds,
  so that check belongs there and is not in this package.

  What the rule does buy: a payer cannot swap in a contract of their own that
  merely exposes a same-named choice and have it SETTLE, which before this check
  it could.

  `DecodedTransfer` gains `exercisedContract` — the resolved contract id, the
  disclosure's signatories and the interface the choice was inherited from, or
  `undefined` when the exercise does not resolve to exactly one agreeing
  disclosure. Verification reads only the interface; the contract id and the
  signatories are there for a caller that can check them against a registry,
  which this layer cannot.

- cc0c8a2: **Breaking.** Read a record's fields the way the engine binds them, and read
  each field at its declared type.

  **The quantifier was inverted.** Daml binds a record BY LABEL only when EVERY
  field carries one; a single unlabeled field puts the whole record in
  DECLARATION ORDER, with each label that remains checked against the name
  declared at its own index. `value.proto` says the same: with all keys present
  the order does not matter, with any key omitted the order MUST match the
  declaration. This read `some` where the engine reads `every`, which handed the
  choice of mode to whoever wrote the blob.

  Blanking ONE label was enough. The engine stayed positional and bound every
  field correctly, so the transfer settled; we switched to the label path, the
  lookup for the blanked field missed, and the field came back `undefined` — not
  refused, dropped. Blanking only `meta` made verify report "this transfer
  carries no memo" about a transfer carrying one, which is the harm the
  both-ways memo check exists to prevent. A merchant quoting no memo and
  reconciling by memo is who that costs.

  **Types were read by coincidence.** One reader rendered party, text and numeric
  alike, so it could not tell a `Party` from a `Text`. `InstrumentId` is declared
  `{admin: Party, id: Text}`; a sub-record written at the wrong types read back
  as a well-formed instrument. Each field is now read at its declared type.

  **The positional indices for `InstrumentId` were backwards** — `{admin, id}`
  in the DAR and in every capture, read as `{id, admin}` here. The test encoder
  had them backwards too, so the positional round-trip tests agreed with the
  mistake that wrote them and could not catch it. Both sides are corrected;
  reverting either now fails four existing tests.

  Each arm is pinned by its own case: the quantifier, the position check, the
  three typed reads, and the indices. Honest traffic is unaffected — a prepared
  transaction's choice argument arrives fully labeled in declaration order.

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

- 23bc463: **Breaking.** `extra.feePayer`, the facilitator's own party, now required and
  quoted from what it advertises.

  ```diff
    "extra": {
      "assetTransferMethod": "transfer-factory",
  +   "feePayer": "x402-facilitator::1220096…",
      "synchronizerId": "global-domain::1220be58c29e",
      "instrumentId": { "id": "Amulet", "admin": "DSO::1220…" },
      "executeBeforeSeconds": 120
    }
  ```

  The scheme spec: `extra.feePayer` MUST be the party that relays the
  payer-signed transfer and pays its traffic fee, and clients MUST NOT alter it.
  The field had nowhere to travel — core's requirements extra did not carry it,
  so nothing quoted it and a facilitator holding payments to the rule had nothing
  to check. `memo` is the only field of `extra` the spec marks optional, so this
  one is required like the rest.

  A merchant discovering its terms gets it from `GET /v2/supported`'s
  `kinds[].extra.feePayer`, which is where a facilitator advertises its party, so
  it is read from the service that will settle the payment rather than copied
  into config.

  The relaying party is the facilitator's own fact, not a merchant's choice, so
  it is always read from `/v2/supported`, as the synchronizer is: neither can be
  configured. A merchant value that differed was stale config or a mistake that
  nothing caught, since the facilitator holds the echoed value against its own
  parties loosely, by design, so a wrong one surfaced as a fee-payer mismatch
  only after the payer had signed.

  **What breaks.** A facilitator that advertises no `feePayer` (it advertises one
  only once a party is configured) cannot be quoted against: that way to pay is
  dropped and reported, rather than issuing a 402 that is refused after the payer
  has signed against it.

  Requirements that carry no `feePayer` also stop parsing as canton-exact, so a
  payment echoing one is refused on shape (`policy_requirements_invalid`) rather
  than by the facilitator's own check. That is a blunter answer than the scheme's
  own code for a wrong relayer, and it is the cost of holding the field required
  here.

  The echoed value is NOT held to the merchant's. It is the facilitator's own,
  and only the facilitator can judge one: it holds the value against its party
  and the earlier ones it still answers to during a rotation. Comparing it in the
  middleware would ask a different question — "is this what I quoted?" — and get
  the rotation wrong, refusing a 402 issued before the party changed that the
  facilitator would have accepted.

  The requirements hash moves, as it did when `synchronizerId` was added: the
  hash covers every value, so a new field changes it though the algorithm is
  untouched. The golden vector was regenerated by running the fixture through the
  facilitator's own canonicalizer as well as this package's — both produced
  byte-identical output and the same digest.

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

  **The middleware's own options** name the asset by instrument id
  (`asset: "Amulet"`); the symbol and the whole instrument are read from the
  facilitator and placed in `extra` when the 402 is built.

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
  core, with `synchronizer` in `extensions.detail` — the shape every other
  mismatch already uses.

  The scheme spec names `extra.synchronizerId` but defines no rule for it and so
  no code, so this one is ours. In the scheme's own family rather than borrowed
  from the protocol's, for two reasons. `invalidReason` is the slot a client
  written against the scheme matches on, and the first cut put `transfer_mismatch`
  there — a protocol-level code of ours, which no such client matches. And the
  obvious substitute,
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

  `GET /v2/supported` advertises it, as `extra.synchronizerId` of the kind being
  quoted, and the middleware always reads it from there: where a deployment
  submits is its own fact, so a merchant cannot configure it.

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

- 583b584: **Breaking.** Core's verify, settle and supported answers have the fields x402
  v2 gives them, under its names, required where it requires them. A buyer
  decodes the settle answer exactly as the facilitator sent it, from
  `PAYMENT-RESPONSE`, so these types are what a client written against the spec
  reads. After 1.0.0, renaming a field or making one required waits for 2.0.

  - **A failed settle** always carries `transaction` and `network` (§5.3.2).
    `transaction` is `""` when nothing was relayed, and on `settlement_pending` it
    is the relayed transfer.
  - **`errorDetails` is gone.** Free text goes in `errorMessage`, which a client
    must not match on (§9). Which of a code's causes it was goes in
    `extensions.detail`, as it does on verify, and a failed settle can now carry
    `extensions`.
  - **A successful settle** may leave out `payer`, has no top-level
    `completionOffset`, and may carry `amount`: the amount settled, in atomic
    units.
  - **`isSettlementPending`** needs a non-empty `network` as well as a non-empty
    `transaction`, as §9 asks of a pending answer. One without it is read as a
    plain failure. Its predicate type is now
    `response is SettleResponseError & { errorReason: "settlement_pending" }`.
    With `transaction` required, the old `& { transaction: string }` added
    nothing, and narrowed the other branch to `never`.
  - **Verify answers** may carry `extra`, and an invalid one may carry
    `invalidMessage` (§5.4.2).
  - **`SupportedResponse`** requires `extensions`, a list of extension ids, and
    `signers`, lists of signers keyed by network pattern such as `canton:*`
    (§7.3.1). A hand-built `{ kinds }` passed to `selectDeployments` or
    `selectCantonDeployments` no longer type-checks.
  - **`decodePaymentResponseHeader`** requires `transaction` and `network` on a
    failure too, and refuses an `errorMessage` or `amount` that is not a string
    and an `extensions` that is not an object. A reason or a field it does not
    know still passes.

  **For a merchant on `@chainsafe/x402-express`,** the `details` of a failed
  settle's 402, and the `details` `onReject` receives, now come from
  `extensions.detail`, or from `errorMessage` when the answer names no cause.
  They used to come from `errorDetails`, which a facilitator still writing it now
  leaves unread. A pending 402's body names the `network` beside the
  `transaction`.

  ### What a facilitator changes

  | was                                          | now                                             |
  | -------------------------------------------- | ----------------------------------------------- |
  | `errorDetails` holding a cause code          | `extensions.detail`                             |
  | `errorDetails` holding free text             | `errorMessage`                                  |
  | a failure with no `transaction` or `network` | `transaction: ""` (or the hash), plus `network` |
  | `completionOffset`                           | dropped, or put in `extensions`                 |
  | `extensions.settledAmount` (a decimal)       | `amount` (atomic units)                         |
  | `/supported` answering `{ kinds }`           | `{ kinds, extensions, signers }`                |

- deeae58: Verification refuses with the error reason codes the specs define.

  `invalidReason` is now the Canton `exact` scheme spec's code, the one a client
  written against the spec matches on: `invalid_exact_canton_amount_mismatch`
  rather than `transfer_mismatch` with detail `amount`, and so on, and
  `extensions.detail` names which of that code's causes it was.

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
  or `invalid_network` when it has the scheme on other networks. It used to
  annotate both `scheme_mismatch`, which is exactly why the pair could not be
  told apart from the extension; now the code says it and there is no extension.

  `VerifyInvalidReason` and `SettleErrorReason` take every code the scheme spec
  and the x402 v2 spec define, plus `invalid_exact_canton_synchronizer_mismatch`,
  and nothing else. The older codes in the left column are no longer accepted, so
  an answer from a facilitator on a published 0.1.x carrying one of them no
  longer parses.

  The Express middleware passes `invalidReason` through as the 402's `error`, so
  a merchant that matches on it, or on `onReject`'s `reason`, sees the new codes,
  with the cause in `onReject`'s `extensions.detail`. The middleware's own
  refusal of a transfer it cannot decode now says
  `invalid_exact_canton_malformed_payload` too.

### Minor Changes

- 6b2c58a: `settlement_pending` is no longer read as a failure. A facilitator answers it
  when it relayed the transfer and could not read the outcome: the transfer may
  still commit, so the payer must not be asked to pay again
  (ChainSafe/canton-x402-facilitator#362).

  - **core.** A settle failure carries `transaction` and `network`, and can
    carry `payer`; a pending answer names its transfer in `transaction`, and its
    `network`. `isSettlementPending` recognises one, and
    `encodePaymentResponseHeader` / `decodePaymentResponseHeader` carry a settle
    answer in the `PAYMENT-RESPONSE` header.
  - **express.** On a pending answer the middleware answers 402 with the
    facilitator's answer in `PAYMENT-RESPONSE`, without serving the request,
    without a fresh challenge, and without calling `onReject`. It does not settle
    again: that waits for a facilitator that can look a pending submission up.
  - **client.** `FacilitatorClient` returns a settle failure sent with 200,
    pending included, as a value; a failure sent with a 4xx still throws.

- 5717756: Read a facilitator's `/v2/supported` as configuration.

  `kinds[].extra` is Optional and scheme-defined in x402 v2 §7.3, and a canton
  deployment puts in there what it settles: the synchronizer it submits to, the
  instruments it validates — each with the registry party that admins it — and the
  transfer methods it speaks. Those are the facts a merchant needs in order to
  quote, and reading them from the facilitator means reading them from the service
  that will accept or refuse the payment, rather than from a constant someone
  copied into a deployment and has to keep true.

  ```ts
  selectCantonDeployments(await facilitator.supported());
  // [{ scheme, network, asset: "CC", extra: { instrumentId: { id, admin }, synchronizerId } }]
  ```

  ### Plural, because `accepts[]` is

  A 402 advertises a LIST of ways to pay, so these return lists and the preference
  takes lists — a merchant accepting two instruments is making a choice, not
  failing to make one:

  ```ts
  selectCantonDeployments(supported, { networks: ["canton:devnet"], instruments: ["Amulet"] });
  ```

  One entry per instrument per kind, in the order the facilitator advertised them,
  so a merchant's `accepts[]` is predictable.

  There is no singular form. Core reports what is on offer; whether offering
  several is an error is the merchant layer's call, and that layer is also the only
  one that can say how to fix it, because it knows the quote is configured as
  `network:`/`instrument:` on a requirements spec — not as these parameters.

  Plural is the right primitive on its own terms too: "exactly one, else refuse" is
  three lines on top of a list, while a list cannot be recovered from a function
  that throws on several. The refusing form is the lossy one.

  Each entry still needs its own price — a merchant advertising two instruments is
  quoting two amounts, and 0.05 of one token is not 0.05 of another — so these
  return terms, not quotes. The pairing stays the merchant's.

  ### Split the way the wire types are

  Picking WHICH kinds match is the protocol's business; reading `kinds[].extra` is
  the scheme's, because `extra` is scheme-defined and no two schemes spell it the
  same way. So the generic half takes the scheme's reader as an argument:

  ```ts
  selectDeployments<TExtra>(
    supported: SupportedResponse,
    selectExtra: DeploymentExtraSelector<TExtra>,
    prefer?: DeploymentPreference,
  ): Array<DeploymentTerms<TExtra>>
  ```

  `DeploymentTerms<TExtra>` carries `scheme`, `network` and `asset` — every
  scheme's, since the spec types `asset` as a string whatever the scheme — with the
  rest under `extra`, mirroring `X402PaymentRequirements<TExtra>` →
  `CantonPaymentRequirements`. The seam is plural at both levels: a selector
  returns a list, so one kind can offer several ways to pay.

  Zero matches is settled before any scheme code runs; the selector then runs once
  per matching kind, because until it has there is no way to know how many ways to
  pay there are.

  ### What a canton-exact `extra` must carry

  `transferMethods`, `synchronizerId` and `carriages` are required, and a kind
  whose `extra` lacks one is not a canton-exact deployment. `instruments` stays
  optional; what an absent or empty list means is below.

  `cantonSupportedExtra` throws `MalformedSupportedExtraError` naming the field
  rather than returning `{}`. Swallowing the failure would mean one bad key
  discards every good one — the synchronizer and the instruments with it — and
  the caller is then told the deployment "advertises no instrument", which is
  false and unactionable. Unknown keys still pass: only the keys this scheme
  defines are checked.

  Because the advertised `synchronizerId` is required, the derived
  `CantonDeploymentExtra.synchronizerId` is no longer optional.

  ### What it refuses

  Not ambiguity — that is the merchant layer's call. But a preference nothing
  matches is an error naming what the facilitator does settle — the kinds it has,
  or the instruments it lists. Only that: how to change the request is the
  caller's business, for the same reason there is no singular form.

  So is a response that contradicts itself: an instrument whose top-level `admin`
  and whose `instrumentId.admin` disagree is inconsistent about who validates the
  holding, and quoting either half would be a guess at which is right.

  ### Also

  The exported surface is `selectDeployments`, `selectCantonDeployments`,
  `cantonSupportedExtra`, the two error types and the types themselves. Kind
  filtering and canton's own extra selector stay internal — nothing outside needs
  them, and `supported.kinds` is right there for anyone wanting the raw list.

  Canton Coin is read only when a deployment lists it. The registered
  implementation leaves it implied by the scheme and lists CIP-56 tokens only, so
  discovery against one of those returns its other instruments and not CC. Ours
  lists it explicitly, so this costs nothing here. Implying it is
  possible — the DSO is `DSO::` plus the advertised synchronizer's namespace —
  and deliberately not done, so that a quote always rests on what a facilitator
  answered rather than on a convention.

  Nothing consumes this yet; the Express middleware does in a follow-up.

  The docs now point at `extra.instruments[]` rather than the superseded
  `extra.asset.instrumentId`, which says the same thing for one instrument only.

### Patch Changes

- 0e29c23: `DEFAULT_MAX_DECOMPRESSED_BYTES` is 72 KiB, not the 64 the scheme recommends.
  Canton 3.7 grew the fixed overhead of a prepared transaction from about 13 KiB
  to about 25 KiB while the cost of an input stayed flat at 5086 bytes, so a
  payer spending eight holdings inflates to 66213 bytes and was refused as
  `invalid_exact_canton_malformed_payload` by 677 of them — 1% of the bound, for
  a payment with nothing wrong with it.

  72 and no more. `DEFAULT_MAX_COMPRESSED_BYTES` stays at 8 KiB and is what binds
  next: nine holdings gzip to about 8.2 KiB and are refused before this bound is
  read, so 72 KiB admits everything 8 KiB of gzip can carry and a larger value
  would buy no payer anything. The compressed cap does not contain a
  decompression bomb — gzip reaches 1026:1, so 8 KiB of member can ask for 8 MB —
  and this bound is the only thing that refuses one, which is the reason to take
  the smallest value that does the job.

  Nothing changes on the wire: the header carries the compressed member, whose
  cap is untouched. Both bounds remain per-call overridable through
  `PreparedTransactionLimits`, and the scheme's requirement is that bounds exist
  and abort incrementally, which this keeps. A facilitator on the recommended
  64 KiB still refuses the payer this admits, so the portable fix is an amendment
  to the recommendation.

- 5b9e1f6: `decodePreparedTransaction` requires the transaction to be a single tree whose
  root is the transfer, and refuses more than one transfer in it.

  A payment is one command, so its transaction is one tree and that tree's root
  is the transfer being paid for. Before this, a transfer could sit beside
  another root or beneath another exercise, and a second transfer was silently
  ignored — so a facilitator could relay, and pay the traffic fee for, legs the
  verifier never looked at, while the input-sufficiency check covered one
  transfer where execution needed them all.

  Not a signature bypass: every node in the tree is covered by the signed hash,
  so the payer authorised all of it. This is about the decoder answering a
  narrower question than the verifier is asking.

  Consequences of the transfer — the children its own choice produces — are
  unaffected and still decode. Canton does not produce a payment shaped any other
  way, so real traffic is unaffected.

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

- 14f9c6b: `decodePreparedTransaction` now reads a prepared transaction the way Canton
  does. It refuses an encoding a full protobuf decoder would read differently (a
  singular field written more than once, more than one member of a oneof, a tag
  or length longer than 5 bytes, a varint value longer than 10 bytes, invalid
  UTF-8, groups), reads only the node tree under the transaction's roots, and
  refuses repeated or non-canonical node ids, nodes outside that tree, and a
  transfer under a rollback node. Canton never produces any of these, so real
  transactions are unaffected; the verifier reports them as
  `invalid_exact_canton_malformed_payload` (`undecodable`).
- dd04309: Upgrade `@canton-network/core-tx-visualizer` from `~1.7.0` to `^1.16.0`, which
  fixes a wrong Canton V2 signing hash.

  1.7.0 encodes a Daml `Int64` through `parseInt`:

  ```js
  } else if (value.sum.oneofKind === "int64") {
      await encodeInt64(parseInt(value.sum.int64))      // a double
  } else if (value.sum.oneofKind === "timestamp") {
      await encodeInt64(BigInt(value.sum.timestamp))    // correct
  ```

  `parseInt` returns a double, so any `Int64` beyond 2^53 hashes wrong and two
  different values can produce the same hash — on the path where the payer's
  Ed25519 signature is verified. The asymmetry with the adjacent `timestamp`
  branch is what makes it a bug rather than a scheme choice.

  Upstream extracted the hashing into `@canton-network/core-tx-hashing`, which
  1.16.0 depends on and delegates to. That package has no `parseInt` anywhere,
  passes `sum.int64` through, and adds the traversal bounds (`DEFAULT_LIMITS`,
  `maxDepth`, `maxNodes`) that 1.7.0's hasher had nowhere — on a path that runs
  over attacker-supplied base64 BEFORE the signature is checked.

  An upgrade rather than a switch: `decodePreparedTransaction` and
  `hashPreparedTransaction` keep their names and signatures, every new parameter
  is optional, and the three import sites compile unchanged.

  **The payment path is unchanged.** Differentially hashed across both versions:
  the committed vector, the facilitator's own captured LocalNet
  `TransferFactory_Transfer` (identical on both, and equal to the payer's signed
  hash), and the 24 V2 plus 7 mutation vectors upstream captures from a Canton
  3.5.10 / protocol-35 participant. Exactly ONE input class hashes differently,
  and it is the bug: a Daml `Int64` beyond 2^53.

  **Behaviour change, fail-closed.** 1.16.0 refuses a prepared transaction
  carrying protobuf fields it does not know, where 1.7.0 hashed past them. On our
  own LocalNet fixture with an unknown top-level field appended, 1.7.0 returns the
  _unchanged_ hash — it hashed a blob carrying bytes it could not see — and
  1.16.0 throws `TxHashingError: … the hash would not cover it`. The verifier
  already wraps the hash call and fails closed, so this surfaces as
  `invalid_exact_canton_malformed_payload`.

  That is correct, but it is a cliff worth recognising in logs: if a payer's
  participant runs a Canton newer than this package's `core-ledger-proto` and
  populates a new `PreparedTransaction` field, every such payment is refused
  rather than verified. Under 1.7.0 it would have been hashed — wrongly, against
  bytes the hash did not cover. Failing is the right answer; the point is that the
  failure is a version skew, not a bad payer.

## 0.1.1

### Patch Changes

- 28c4a67: Fix the release pipeline so all packages publish. `changeset publish` ran each package's `prepack: tsup` in parallel, and a dependent's type-declaration build could read a sibling's `dist` while that sibling was mid-rebuild, failing to publish `x402-express` and `x402-server-sdk`. The `prepack` hook is removed; the single topological `pnpm build` in CI is now the authoritative build and publish ships those artifacts. No runtime or API change.

## 0.1.0

### Minor Changes

- aec5534: First public release on npm.
