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
      "scheme": "exact-canton",
      "network": "canton:1220be58c2…",
      "extra": {
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
| `scheme`                   | `exact-canton` for Canton Coin. Copy into `paymentRequirements.scheme`.                                                                                                                    |
| `network`                  | `canton:` plus the synchronizer id's namespace, the part after `::` (`global-domain::1220…` becomes `canton:1220…`). Copy into `paymentRequirements.network`.                              |
| `extra.asset.instrumentId` | The asset to price in — `{ id, admin }`. `admin` is the network's DSO party: it admins Amulet, and the facilitator checks payments against it, so configure from here rather than by hand. |

### curl

```bash
curl -sS "$FACILITATOR_URL/v2/supported"
```

## `POST /v2/verify`

- **URL:** `$FACILITATOR_URL/v2/verify`
- **Auth:** your API key, as `Authorization: Bearer`. A missing or unknown key answers `401`, and so does a key whose project has no payout party yet.
- **Rate limited:** over the limit answers `429` with a `Retry-After` header.

### What it does

Runs the checks settle runs before it reserves the nonce, and writes nothing to
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
    "scheme": "exact-canton",
    "network": "canton:1220be58c2…",
    "payload": {
      "payer": "buyer::1220…",
      "preparedTransaction": "<base64 blob from interactive-submission/prepare>",
      "preparedTransactionHash": "<hex of the hash that was signed>",
      "partySignature": "<hex Ed25519 signature over preparedTransactionHash>",
      "requirementsHash": "<sha256 of the canonical paymentRequirements>",
      "publicKey": "<base64 32-byte Ed25519 public key>",
      "hashingSchemeVersion": "HASHING_SCHEME_VERSION_V2"
    }
  },
  "paymentRequirements": {
    "scheme": "exact-canton",
    "network": "canton:1220be58c2…",
    "maxAmountRequired": "0.05",
    "asset": { "instrumentId": { "id": "Amulet", "admin": "DSO::1220be58c2…" } },
    "payTo": "merchant::1220…",
    "resource": "https://api.example.com/paid",
    "description": "Access to /paid",
    "nonce": "3f1c…",
    "validBefore": "2026-08-14T13:05:00.000Z"
  }
}
```

### Body fields

| Field                                       | Rule                                                                                                                                                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `x402Version`                               | Must be exactly `2`, at the top level and inside `paymentPayload`.                                                                                                                                                                                                             |
| `paymentPayload.payload`                    | The seven fields above, all required. `publicKey` replaced the older `keyFingerprint` — the facilitator derives the fingerprint from the key and matches it against the payer party's `::` suffix.                                                                             |
| `requirementsHash`                          | SHA-256 of the RFC 8785 canonicalization of `paymentRequirements`; it must match the requirements sent alongside it. The signature itself covers the prepared transaction, whose sender, receiver, instrument and amount the facilitator checks against `paymentRequirements`. |
| `maxAmountRequired`                         | Decimal string with at most 10 decimal places, and a floor rather than an exact amount — an overpayment settles and reports what actually moved.                                                                                                                               |
| `payTo`                                     | Must be a party your API key owns. Otherwise verify answers `transfer_mismatch` and settle answers `unauthorized`.                                                                                                                                                             |
| `resource`                                  | Required — the URL being paid for.                                                                                                                                                                                                                                             |
| `nonce`, `validBefore`                      | Required and non-empty; `validBefore` is ISO 8601 and settle refuses a quote past it.                                                                                                                                                                                          |
| `description`, `maxTimeoutSeconds`, `extra` | Optional.                                                                                                                                                                                                                                                                      |

### Response 200 — accepted

```json
{ "isValid": true, "payer": "buyer::1220…" }
```

### Response 200 — rejected

```json
{
  "isValid": false,
  "invalidReason": "transfer_mismatch",
  "payer": "buyer::1220…",
  "extensions": { "detail": "amount" }
}
```

### `invalidReason` values

`scheme_mismatch`, `network_mismatch`, `requirements_expired`,
`requirements_hash_mismatch`, `bad_fingerprint`, `bad_signature`,
`nonce_replayed`, `missing_public_key`, `transfer_mismatch`, `internal_error`

A body that is not a well-formed request answers `400` with
`invalidReason: "bad_request"`, and an unexpected fault answers `500` with
`internal_error`.

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
    "scheme": "exact-canton",
    "network": "canton:1220be58c2…",
    "payload": {
      "payer": "buyer::1220…",
      "preparedTransaction": "…",
      "preparedTransactionHash": "…",
      "partySignature": "…",
      "requirementsHash": "…",
      "publicKey": "…",
      "hashingSchemeVersion": "HASHING_SCHEME_VERSION_V2"
    }
  },
  "paymentRequirements": {
    "scheme": "exact-canton",
    "network": "canton:1220be58c2…",
    "maxAmountRequired": "0.05",
    "asset": { "instrumentId": { "id": "Amulet", "admin": "DSO::1220be58c2…" } },
    "payTo": "merchant::1220…",
    "resource": "https://api.example.com/paid",
    "nonce": "3f1c…",
    "validBefore": "2026-08-14T13:05:00.000Z"
  }
}
JSON
```

## `POST /v2/settle`

- **URL:** `$FACILITATOR_URL/v2/settle`
- **Auth:** your API key, as `Authorization: Bearer`. A missing or unknown key answers `401`, and so does a key whose project has no payout party yet.
- **Rate limited:** over the limit answers `429` with a `Retry-After` header.

### What it does

Re-runs verify, reserves the nonce so a concurrent replay cannot spend it, and
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
    "scheme": "exact-canton",
    "network": "canton:1220be58c2…",
    "payload": {
      "payer": "buyer::1220…",
      "preparedTransaction": "<base64 blob from interactive-submission/prepare>",
      "preparedTransactionHash": "<hex of the hash that was signed>",
      "partySignature": "<hex Ed25519 signature over preparedTransactionHash>",
      "requirementsHash": "<sha256 of the canonical paymentRequirements>",
      "publicKey": "<base64 32-byte Ed25519 public key>",
      "hashingSchemeVersion": "HASHING_SCHEME_VERSION_V2"
    }
  },
  "paymentRequirements": {
    "scheme": "exact-canton",
    "network": "canton:1220be58c2…",
    "maxAmountRequired": "0.05",
    "asset": { "instrumentId": { "id": "Amulet", "admin": "DSO::1220be58c2…" } },
    "payTo": "merchant::1220…",
    "resource": "https://api.example.com/paid",
    "description": "Access to /paid",
    "nonce": "3f1c…",
    "validBefore": "2026-08-14T13:05:00.000Z"
  }
}
```

### Response 200 — settled

`transaction` is the Canton update id.

```json
{
  "success": true,
  "network": "canton:1220be58c2…",
  "transaction": "1220a3f…",
  "completionOffset": "42",
  "payer": "buyer::1220…",
  "extensions": { "settledAmount": "0.05", "nonce": "3f1c…" }
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

`bad_request`, `unauthorized`, `scheme_mismatch`, `network_mismatch`,
`requirements_expired`, `requirements_hash_mismatch`, `bad_fingerprint`,
`bad_signature`, `nonce_replayed`, `execution_failed`, `timeout`,
`facilitator_error`

Every refusal above answers `400`. An unexpected fault answers `500`, and a
facilitator that is temporarily out of capacity answers `503` with a
`Retry-After` header; both carry `facilitator_error`.

### curl

```bash
# payment.json holds the body above
curl -sS -X POST "$FACILITATOR_URL/v2/settle" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $FACILITATOR_API_KEY" \
  -d @payment.json
```
