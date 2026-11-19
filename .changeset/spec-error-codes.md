---
"@chainsafe/x402-core": major
"@chainsafe/x402-express": major
---

Verification refuses with the error reason codes the specs define.

`invalidReason` is now the Canton `exact` scheme spec's code, the one a client
written against the spec matches on: `invalid_exact_canton_amount_mismatch`
rather than `transfer_mismatch` with detail `amount`, and so on, and
`extensions.detail` names which of that code's causes it was.

| before | now |
| --- | --- |
| `scheme_mismatch` | `unsupported_scheme` |
| `network_mismatch` | `invalid_network` |
| `internal_error`, for another `x402Version` | `invalid_x402_version` |
| `internal_error`, for requirements that are not canton-exact | `invalid_payment_requirements` |
| `internal_error`, for a missing `preparedTransaction`, `preparedTxHash` or `signature`; `missing_public_key`, for a missing key | `invalid_exact_canton_missing_proof` |
| `internal_error`, for a payload that is not canton-exact (an empty hash or signature included) or a hashing scheme other than V2; `invalid_prepared_transaction_structure`; `transfer_mismatch` with detail `undecodable` | `invalid_exact_canton_malformed_payload` |
| `bad_signature`, `bad_fingerprint`, `prepared_transaction_hash_mismatch`; `missing_public_key`, for a key that is not one | `invalid_exact_canton_signature_invalid` |
| `transfer_mismatch` with detail `amount` / `receiver` / `instrument` / `memo` | `invalid_exact_canton_amount_mismatch` / `_merchant_mismatch` / `_instrument_id_mismatch` / `_memo_mismatch` |
| `transfer_expired` | `invalid_exact_canton_expired` |

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
