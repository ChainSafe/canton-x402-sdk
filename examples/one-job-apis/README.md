# One-job APIs — developer relations demo

Seventy bite-sized paid HTTP jobs in one catalog. Twelve of them run in this build through the real `@chainsafe/x402-express` `paymentRequired` middleware. The rest are listed only: they never return a fake result and never charge.

The point is not eight fake companies. It is one pattern: `POST /v1/{tool}`, a 402 with machine-readable terms, pay, verify, settle, 200 with the result. A person uses the tool on a phone. A developer opens **What happened** and sees the exchange from that call.

## What is real

- Merchant wiring: `paymentRequired`, `FacilitatorClient`, facilitator-owned fields from `GET /v2/supported` (`feePayer`, instrument admin, synchronizer).
- Headers: `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`.

## What is a stand-in

The browser cannot fingerprint-sign a Canton prepared transaction. **Pay** is the human approval step. The UI asks `POST /demo/sign` for a schema-valid `PAYMENT-SIGNATURE` (not a ledger transfer). The in-process facilitator answers verify and settle with HTTP 200 verdicts. The disclosure says so in plain language.

## Run it

From the monorepo root, build the SDK packages the example imports (JS output is enough if DTS fails locally):

```bash
corepack pnpm install
corepack pnpm --filter @chainsafe/x402-core --filter @chainsafe/x402-client --filter @chainsafe/x402-express exec tsup --no-dts
```

Two terminals:

```bash
corepack pnpm --filter @chainsafe/x402-example-one-job-api dev
corepack pnpm --filter @chainsafe/x402-example-one-job-web dev
```

Open http://localhost:5180 (default). The UI proxies `/api` to the API on port 8787.

Quick check without the UI:

```bash
curl -sS -X POST http://127.0.0.1:8787/v1/hash.sha256 -H 'content-type: application/json' -d '{"text":"hello"}' -D - | head
```

## Test

```bash
corepack pnpm --filter @chainsafe/x402-example-one-job-api test
```

## Layout

| Package | Role |
| --- | --- |
| `catalog/` | Seventy tools, prices, live flags |
| `api/` | Express merchant + in-process facilitator + twelve handlers |
| `web/` | Phone-friendly UI and the **What happened** panel |

Start with `hash.sha256`: unpaid 402, Pay, then the trace and the digest.