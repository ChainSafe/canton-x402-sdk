---
description: The public contract for this SDK release. The wire types in @chainsafe/x402-core are the machine-readable source.
---

# Protocol contract

This is the contract this SDK release implements. The machine-readable source
is the schemas in `@chainsafe/x402-core`. Field-level request and response
tables are in the [API reference](/api-reference). A facilitator backend may
still change how it reaches a verdict. It does not change the verdicts, headers,
or retry rule below.

## One paid call

1. The resource server answers an unpaid request with `402` and
   `PAYMENT-REQUIRED`: `{ x402Version: 2, resource, accepts }`.
2. The payer chooses one `accepts[]` entry, prepares a Canton transfer, and
   signs its hash. The private key stays with the payer.
3. The retry carries that payment in `PAYMENT-SIGNATURE`. `X-PAYMENT` is still
   read when `PAYMENT-SIGNATURE` is absent, for a payment of this shape.
4. The merchant checks the echoed requirements against its own terms, then
   calls `POST /v2/verify` and, when configured to capture, `POST /v2/settle`.
5. A successful settle returns the Canton update id. The merchant puts that
   answer in `PAYMENT-RESPONSE` and serves the resource.

`createX402Fetch` performs steps 2 and 3 for a challenge that contains
`PAYMENT-REQUIRED`.

## What the facilitator owns

`GET /v2/supported` is the source for the instrument registry admin, the
synchronizer, and `feePayer`. Express reads them when it quotes. A merchant
spec names the instrument id (`asset: "Amulet"`) and may name `network` to
choose a deployment. It cannot set the admin, `synchronizerId`, or `feePayer`.
Naming `network` does not skip discovery.

A builder that writes those `extra` fields itself is checked against
`/v2/supported` before the 402 is issued. A mismatch is a `TermsError`.

See [Upgrading](/upgrading) if a merchant config still sets them.

## Verdicts are HTTP 200

`/v2/verify` and `/v2/settle` return an evaluated payment outcome with HTTP 200,
including `{ isValid: false }` and `{ success: false }`.
`FacilitatorClient` returns those as `VerifyResponse` and `SettleResponse`.

HTTP 400, 401, 429, 500, and 503 are protocol or transport failures.
`FacilitatorClient` throws `FacilitatorError` for any non-2xx response. A 400
is not a payment verdict and must not be retried as one.

## `settlement_pending`

The signed transaction was submitted and the ledger outcome is not known.
This is not a failure and not a reason to sign a second transfer.

Verify returns it when a retry reaches a transaction the facilitator has
already seen:

```json
{
  "isValid": false,
  "invalidReason": "settlement_pending",
  "extensions": { "detail": "submission_replayed" },
  "extra": { "transaction": "<preparedTxHash>", "network": "canton:devnet" }
}
```

Settle returns it on the settle body itself. There, `transaction` is also the
`preparedTxHash`. On a successful settle, `transaction` is the Canton update id.
Read the reason code before interpreting `transaction`.

Express answers either case with `402` and `PAYMENT-RESPONSE` only. It does not
send `PAYMENT-REQUIRED`, does not serve the route, and does not call
`onReject`. A pending verify answer that omits `extra.transaction` or
`extra.network` is an ordinary refusal, because the buyer would have nothing
to resend.

`createX402Fetch` returns that pending 402 without signing again. A later call
starts from an unpaid request, receives a new challenge, and would sign a new
transfer. To stay on the first payment, resend the original
`PAYMENT-SIGNATURE`.
