# One-job APIs — developer relations demo

Seventy bite-sized paid HTTP jobs in one catalog. **All of them** run in this build through the real `@chainsafe/x402-express` `paymentRequired` middleware — same x402 headers, same pay flow. Some jobs are thin demos (e.g. headless screenshots) and say so in the response.

The point is not eight fake companies. It is one pattern: `POST /v1/{tool}`, a 402 with machine-readable terms, pay, verify, settle, 200 with the result. A person uses the tool on a phone. A developer opens **What happened** and sees the exchange from that call.

**Bulk sales (for buyers who hate micro-payments):** under **Jobs**, buy a **25 / 100 / 500 call pack** with one passkey + one x402 receipt. After that, job runs spend **prepaid quota** — no passkey and no 402 per call until the pack is empty. Then the normal x402 flow returns.

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

Three terminals:

```bash
corepack pnpm --filter @chainsafe/x402-example-one-job-api dev
cp examples/one-job-apis/gateway/.env.example examples/one-job-apis/gateway/.env
# Add Google OAuth client ID/secret, or set ALLOW_DEV_LOGIN=1 until credentials exist
corepack pnpm --filter @chainsafe/x402-example-one-job-gateway dev
corepack pnpm --filter @chainsafe/x402-example-one-job-web dev
```

Open http://localhost:5180 (append `?presenter=1` for a wider layout on a projector). With `ALLOW_DEV_LOGIN=1` (default in `.env.example`): **Enter demo** → **Enable fingerprint** → pick a live tool (e.g. `hash.sha256`) → **Place finger**. Add Google OAuth to the gateway `.env` when you want **Continue with Google**.

The UI proxies `/api` to the merchant (:8787) and `/gateway` to the auth service (:8790). Deploying on **Google Cloud** (GCS for the built UI, Cloud Run for the gateway) is in [docs/DEPLOY-GCP.md](./docs/DEPLOY-GCP.md). WebAuthn does not run on GCS alone.

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
| `catalog/` | Seventy tools, prices, all live |
| `api/` | Express merchant + in-process facilitator + seventy handlers |
| `web/` | Phone-friendly UI, fingerprint UX, **What happened** panel |
| `gateway/` | Google sign-in, WebAuthn, daily spend cap, paid-call proxy |

Start with `hash.sha256`: unpaid 402, Pay, then the trace and the digest.