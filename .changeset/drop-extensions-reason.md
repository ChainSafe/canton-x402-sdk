---
"@chainsafe/x402-core": major
"@chainsafe/x402-express": major
---

**Breaking.** A verify refusal no longer carries `extensions.reason`. What it
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

| removed from | codes |
| --- | --- |
| `VerifyInvalidReason` | `scheme_mismatch`, `network_mismatch`, `requirements_hash_mismatch`, `bad_fingerprint`, `bad_signature`, `prepared_transaction_hash_mismatch`, `invalid_prepared_transaction_structure`, `missing_public_key`, `transfer_mismatch`, `transfer_expired`, `internal_error`, `nonce_replayed` |
| `SettleErrorReason` | `unauthorized`, `scheme_mismatch`, `network_mismatch`, `requirements_hash_mismatch`, `bad_fingerprint`, `bad_signature`, `facilitator_error`, `nonce_replayed`, `bad_request`, `execution_failed`, `timeout` |

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

| was | becomes |
| --- | --- |
| `execution_failed` | `invalid_exact_canton_execute_failed` for a definite ledger rejection, the scheme spec's own name for one |
| `bad_request` | `invalid_payload` for a malformed body; it was invented, and was never in this list on the verify side where it is also written |
| `timeout` | nothing: since ChainSafe/canton-x402-facilitator#373 an unknown outcome is the non-terminal `settlement_pending`, so no facilitator sends it |

**A facilitator must migrate six codes,** the ones it still writes. Not all of
them map one-for-one, because some are used for more than one cause:

| it writes | for | answer instead |
| --- | --- | --- |
| `bad_request` | a malformed body | `invalid_payload` |
| `internal_error` | an unexpected fault in verify | `unexpected_verify_error` |
| `internal_error` | the minimum-amount policy (`authorization_amount_too_low`, `invalid_amount`) | `invalid_payment_requirements`: a policy refusal of the quoted amount, not an unexpected error |
| `facilitator_error` | an unexpected fault in settle | `unexpected_settle_error` |
| `execution_failed` | a definite ledger rejection | `invalid_exact_canton_execute_failed` |
| `execution_failed` | `settlement_currency_unsupported` | `invalid_payment_requirements`: the merchant's configuration is at fault, and `execute_failed` would tell the payer to sign again |
| `unauthorized` | a verify `missing_public_key`, mapped onto settle | nothing to map: core now answers `invalid_exact_canton_signature_invalid`, which passes through as a settle reason |
| `nonce_replayed` | the same signed transaction presented again | see below |

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
