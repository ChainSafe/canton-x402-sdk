---
description: The three endpoints an integration calls, with request and response shapes, status codes, and curl.
---

# API reference

The three endpoints an integration calls, with request and response shapes,
status codes, and curl. `@chainsafe/x402-express` already calls `/v2/verify`
and `/v2/settle` for you (steps 5 and 6 of [the payment flow](/payment-flow));
this page is for calling the facilitator directly, or for reading what the
middleware sends. What each verify check means is on
[The facilitator](/facilitator#what-verify-guarantees).

`$FACILITATOR_URL` below is your facilitator's base URL. The integration panel
on the merchant dashboard's **API keys** page shows it, and `$FACILITATOR_API_KEY`
is a key you create on that same page (it is shown only once). Both are the
names the panel's `.env` uses.

## `GET /v2/supported`

- **URL:** `$FACILITATOR_URL/v2/supported`
- **Auth:** open — no credentials required.

### Request headers

None required. There is no request body.

### Response 200

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "canton:devnet",
      "extra": {
        "transferMethods": ["transfer-factory"],
        "synchronizerId": "global-domain::1220be58c2…",
        "feePayer": "x402-facilitator::1220096…",
        "carriages": ["inline"],
        "instruments": [
          {
            "admin": "DSO::1220be58c2…",
            "instrumentId": { "id": "Amulet", "admin": "DSO::1220be58c2…" },
            "symbol": "CC"
          }
        ],
        "asset": {
          "instrumentId": {
            "id": "Amulet",
            "admin": "DSO::1220be58c2…"
          }
        }
      }
    }
  ]
}
```

### Fields

| Field                      | Meaning                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kinds[]`                  | One entry per (scheme, network) pair the deployment settles. A deployment on one Canton network returns exactly one.                                                                       |
| `scheme`                   | `exact` — the scheme id defined by the registered Canton scheme spec. Copy into `paymentRequirements.scheme`.                                                                              |
| `network`                  | A network name: `canton:mainnet`, `canton:testnet`, `canton:devnet` or `canton:localnet`. It does not carry the synchronizer id — read it from here rather than deriving it.              |
| `extra.instruments[]`      | What the deployment settles, one entry per instrument: `instrumentId` as `{ id, admin }`, the registry `admin` party, and a display `symbol`. `admin` is the party the facilitator checks a payment's holding against, so configure from here rather than by hand. `paymentRequired()` reads the `admin` for you when a way to pay names its `asset` by id. |
| `extra.synchronizerId`     | The synchronizer the deployment submits to — the id a payer prepares its transfer against. |
| `extra.feePayer`           | The party that relays a payer-signed transfer and pays its traffic fee. Copy into `paymentRequirements.extra.feePayer` — a facilitator refuses a payment naming anyone but itself. Absent until a deployment has a party configured. `paymentRequired()` reads it for you and prefers it over a `feePayer` in your own config, falling back to yours only while none is advertised — and refusing to quote at all if neither can supply one. |
| `extra.transferMethods[]`  | The asset transfer methods it speaks; `transfer-factory` for canton-exact. |
| `extra.carriages[]`        | How a prepared transaction travels. `inline` means it is carried in the `PAYMENT-SIGNATURE` header itself. |
| `extra.asset.instrumentId` | **Superseded by `extra.instruments[]`**, which says the same thing and can say it for more than one instrument. Still sent for merchants reading it; prefer `instruments`. |
| `extra.*`                  | `extra` is Optional and scheme-defined in x402 v2 §7.3, so a deployment may add its own keys and omit any of the above. Read what you need and ignore the rest. |

### curl

```bash
curl -sS "$FACILITATOR_URL/v2/supported"
```

## `POST /v2/verify`

- **URL:** `$FACILITATOR_URL/v2/verify`
- **Auth:** your API key, as `Authorization: Bearer`. A missing or unknown key answers `401`, and so does a key whose project has no payout party yet.
- **Rate limited:** over the limit answers `429` with a `Retry-After` header.

### What it does

Runs the checks settle runs before it reserves the payment, and writes nothing to
the ledger. It is an optional dry run: `/v2/settle` re-verifies from scratch, so
calling verify first buys you a clean rejection before you commit, not a
guarantee.

### Request headers

| Header                           | Rule                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Type: application/json` | Required — any other type leaves the body unparsed and answers `400`.                                                                           |
| `Authorization: Bearer <key>`    | Required — an API key created in the merchant dashboard. A bare key with no `Bearer` prefix is also accepted, for clients that omit the scheme. |
| `X-Request-Id`                   | Optional; echoed back on the response, otherwise one is minted.                                                                                 |

### Request body

```json
{
  "x402Version": 2,
  "paymentPayload": {
    "x402Version": 2,
    "accepted": { "scheme": "exact", "network": "canton:devnet", … },
    "payload": {
      "assetTransferMethod": "transfer-factory",
      "preparedTransaction": "<base64 of the gzipped transaction from interactive-submission/prepare>",
      "preparedTxHash": "<lower-case hex of the 32-byte hash that was signed>",
      "signature": "<base64 Ed25519 signature over preparedTxHash>",
      "hashingSchemeVersion": "HASHING_SCHEME_VERSION_V2"
    }
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "canton:devnet",
    "amount": "500000000",
    "asset": "CC",
    "extra": {
      "assetTransferMethod": "transfer-factory",
      "synchronizerId": "global-domain::1220be58c2…",
      "feePayer": "x402-facilitator::1220096…",
      "instrumentId": { "id": "Amulet", "admin": "DSO::1220be58c2…" },
      "executeBeforeSeconds": 120
    },
    "payTo": "merchant::1220…",
    "maxTimeoutSeconds": 60
  }
}
```

### Body fields

| Field                                       | Rule                                                                                                                                                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `x402Version`                               | Must be exactly `2`, at the top level and inside `paymentPayload`.                                                                                                                                                                                                             |
| `paymentPayload.accepted`                   | Required: the `accepts[]` entry the payer chose, here elided — a whole `PaymentRequirements`, with the `scheme`, `network`, `amount`, `asset`, `payTo` and `maxTimeoutSeconds` the spec requires of one. Its `scheme` must be `exact` and its `network` must equal `paymentRequirements.network` (spec Rule 1), or the answer is `unsupported_scheme` / `invalid_network`. Its other values are not compared: the transfer is bound to `paymentRequirements`, which the merchant takes from it after checking it against its own terms. A body whose `paymentPayload` has no `accepted`, has one with any of those fields missing or empty or a `maxTimeoutSeconds` that is not a whole number of at least 1, or has `scheme` and `network` at the top level instead (the pre-spec envelope), is not a well-formed request: `400` with `invalid_payload`. |
| `paymentPayload.resource`, `paymentPayload.extensions` | Optional; `null` is accepted for either, and neither affects the verdict. `resource` is `{ url, description?, mimeType?, serviceName?, tags?, iconUrl? }` with a non-empty `url`, and `extensions` is an object keyed by extension id. A value of another shape is a malformed body: `400` with `invalid_payload`. |
| `paymentPayload.payload`                    | The six fields above, all required except `hashingSchemeVersion`, which means `HASHING_SCHEME_VERSION_V2` when absent. `assetTransferMethod` must be `"transfer-factory"`, as in the requirements' `extra`; a payload without it or with another value is `invalid_exact_canton_malformed_payload`. `signature` is canonical base64 of the 64-byte signature and `preparedTxHash` is 64 lower-case hex digits; an empty one is `invalid_exact_canton_malformed_payload`, and any other encoding is `invalid_exact_canton_signature_invalid`. A payload missing any of the three is `invalid_exact_canton_missing_proof`. `preparedTransaction` is base64 of exactly one gzip member with no optional header fields, at most 8 KiB compressed and 64 KiB decompressed; anything else is `invalid_exact_canton_malformed_payload`. The payload carries no key: the facilitator reads the sender party's signing keys from the ledger by that party id, and the signature must verify under one of them (`invalid_exact_canton_signature_invalid` otherwise, including when none can be resolved). The signature covers the prepared transaction, whose receiver, instrument and amount the facilitator checks against `paymentRequirements`: that is what binds the payload to them. |
| `amount`                                    | Integer string of atomic units — 1 CC = 1e10, so `"500000000"` is 0.05 CC. **Exact**, not a floor: the transfer must move this amount, and an overpayment is rejected.                                                                                                       |
| `payTo`                                     | Must be a party your API key owns. Otherwise both verify and settle answer `invalid_exact_canton_merchant_not_registered`, with `destination_not_allowed` as the detail.                                                                                                                                                             |
| `asset`                                     | A symbol — `"CC"` for Canton Coin, or a registry token's own. The instrument it names is `extra.instrumentId`.
| `extra.instrumentId`                        | Required `{admin, id}`: `asset` alone cannot say which registry issued the instrument, and the facilitator binds the transfer against this.
| `maxTimeoutSeconds`                         | Required — seconds the client has to complete payment. A whole number of at least 1; `0`, a negative, a fraction and `Infinity` are all refused.
| `extra.assetTransferMethod`                 | Required, and MUST be `"transfer-factory"`. A reserved protocol key, so any other value is refused rather than carried through as scheme data.
| `extra.executeBeforeSeconds`                | Required — seconds from request time. The client turns it into the transfer's `executeBefore`; verification refuses a transfer whose deadline is not still at least 5 seconds ahead (`invalid_exact_canton_expired`).
| `extra.memo`                                | Optional, UTF-8, at most 256 **bytes**. Binds in both directions: the transfer's `x402.memo` must equal it exactly, and a transfer carrying one when you quoted none is refused too — `x402.memo` is the scheme's key, not the payer's. Either way the refusal is `invalid_exact_canton_memo_mismatch`.
| `description`                               | Optional.                                                                                                                                                                                                                                                                      |

### Response 200 — accepted

```json
{ "isValid": true, "payer": "buyer::1220…" }
```

### Response 200 — rejected

```json
{
  "isValid": false,
  "invalidReason": "invalid_exact_canton_amount_mismatch",
  "payer": "buyer::1220…",
  "extensions": { "detail": "amount" }
}
```

### `invalidReason` values

The checks the facilitator shares with the SDK answer with the codes the Canton
`exact` scheme spec defines, so a client written against the spec recognises
them:

`invalid_x402_version`, `unsupported_scheme`, `invalid_network`,
`invalid_payment_requirements`, `invalid_exact_canton_missing_proof`,
`invalid_exact_canton_malformed_payload`,
`invalid_exact_canton_signature_invalid`,
`invalid_exact_canton_amount_mismatch`,
`invalid_exact_canton_merchant_mismatch`,
`invalid_exact_canton_instrument_id_mismatch`,
`invalid_exact_canton_memo_mismatch`, `invalid_exact_canton_expired`

`extensions.detail` says WHICH of a code's causes it was, where the code alone
leaves two apart. `invalid_exact_canton_signature_invalid` is the one that most
needs it: `no_payer_key` (the party publishes none this facilitator can use),
`malformed_encoding` (the hash or signature is not in the encoding the spec
asks for), `hash_mismatch` (the hash describes a different transaction) or
`bad_signature` (it verifies under none of the party's keys). Elsewhere it
names what diverged — the field of a transfer that does not match — or
`undecodable` (the transaction will not gunzip), `structure_undecodable` (it
gunzips but the schema cannot read it), `payload_shape`, `payload_missing`,
`proof_fields_missing`, `unsupported_hashing_scheme`. A code whose cause is not in doubt carries no
`extensions` at all.

A body that is not a well-formed request answers `400` with
`invalid_payload`, and an unexpected fault answers `500` with
`unexpected_verify_error`.

### curl

```bash
curl -sS -X POST "$FACILITATOR_URL/v2/verify" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $FACILITATOR_API_KEY" \
  -d @- <<'JSON'
{
  "x402Version": 2,
  "paymentPayload": {
    "x402Version": 2,
    "accepted": { "scheme": "exact", "network": "canton:devnet", … },
    "payload": {
      "assetTransferMethod": "transfer-factory",
      "preparedTransaction": "…",
      "preparedTxHash": "…",
      "signature": "…",
      "hashingSchemeVersion": "HASHING_SCHEME_VERSION_V2"
    }
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "canton:devnet",
    "amount": "500000000",
    "asset": "CC",
    "extra": {
      "assetTransferMethod": "transfer-factory",
      "synchronizerId": "global-domain::1220be58c2…",
      "feePayer": "x402-facilitator::1220096…",
      "instrumentId": { "id": "Amulet", "admin": "DSO::1220be58c2…" },
      "executeBeforeSeconds": 120
    },
    "payTo": "merchant::1220…",
    "maxTimeoutSeconds": 60
  }
}
JSON
```

## `POST /v2/settle`

- **URL:** `$FACILITATOR_URL/v2/settle`
- **Auth:** your API key, as `Authorization: Bearer`. A missing or unknown key answers `401`, and so does a key whose project has no payout party yet.
- **Rate limited:** over the limit answers `429` with a `Retry-After` header.

### What it does

Re-runs verify, reserves the payment so a concurrent replay cannot spend it, and
submits the payer-signed transaction to Canton. Returns the on-ledger update id.

### Request headers

| Header                           | Rule                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Type: application/json` | Required — any other type leaves the body unparsed and answers `400`.                                                                           |
| `Authorization: Bearer <key>`    | Required — an API key created in the merchant dashboard. A bare key with no `Bearer` prefix is also accepted, for clients that omit the scheme. |
| `X-Request-Id`                   | Optional; echoed back on the response, otherwise one is minted.                                                                                 |

### Request body

```json
{
  "x402Version": 2,
  "paymentPayload": {
    "x402Version": 2,
    "accepted": { "scheme": "exact", "network": "canton:devnet", … },
    "payload": {
      "assetTransferMethod": "transfer-factory",
      "preparedTransaction": "<base64 of the gzipped transaction from interactive-submission/prepare>",
      "preparedTxHash": "<lower-case hex of the 32-byte hash that was signed>",
      "signature": "<base64 Ed25519 signature over preparedTxHash>",
      "hashingSchemeVersion": "HASHING_SCHEME_VERSION_V2"
    }
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "canton:devnet",
    "amount": "500000000",
    "asset": "CC",
    "extra": {
      "assetTransferMethod": "transfer-factory",
      "synchronizerId": "global-domain::1220be58c2…",
      "feePayer": "x402-facilitator::1220096…",
      "instrumentId": { "id": "Amulet", "admin": "DSO::1220be58c2…" },
      "executeBeforeSeconds": 120
    },
    "payTo": "merchant::1220…",
    "maxTimeoutSeconds": 60
  }
}
```

### Response 200 — settled

`transaction` is the Canton update id.

```json
{
  "success": true,
  "network": "canton:devnet",
  "transaction": "1220a3f…",
  "completionOffset": "42",
  "payer": "buyer::1220…",
  "extensions": { "settledAmount": "0.05" }
}
```

### Response 400 — not settled

```json
{
  "success": false,
  "errorReason": "bad_request",
  "errorDetails": "amount"
}
```

### `errorReason` values

The scheme spec's table and the x402 v2 general codes, the same vocabulary
`invalidReason` uses — `invalid_exact_canton_execute_failed` for a definite
ledger rejection, `settlement_pending` when the outcome is not yet known (which
is **non-terminal**, and carries `transaction`), and `unexpected_settle_error`
for a fault during settlement, with `errorDetails` saying which.

Every refusal above answers `400`. An unexpected fault answers `500`, and a
facilitator that is temporarily out of capacity answers `503` with a
`Retry-After` header.

### curl

```bash
# payment.json holds the body above
curl -sS -X POST "$FACILITATOR_URL/v2/settle" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $FACILITATOR_API_KEY" \
  -d @payment.json
```
