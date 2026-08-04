# Mortgage x402 demo — server-to-server pay-per-call on Canton

An end-to-end example of the `@chainsafe/x402-*` SDK: a home-mortgage application where the
lender's backend **pays a credit bureau per credit-score pull** over Canton Coin, via x402.
The payment is machine-to-machine (no wallet UI, no human) — the canonical Phase-1
server-to-server story.

## The three apps

| App | Role | Package | Uses |
| --- | --- | --- | --- |
| `mortgage-ui` | Applicant-facing form (React/Vite) | `@chainsafe/x402-example-mortgage-ui` | — |
| `mortgage-backend` | Lender backend — **x402 payer** | `@chainsafe/x402-example-mortgage-backend` | `@chainsafe/x402-server-sdk` |
| `credit-bureau` | Bureau API — **x402 merchant** | `@chainsafe/x402-example-mortgage-bureau` | `@chainsafe/x402-express` |

**Where money moves:** only **mortgage-backend → credit-bureau** (0.05 CC, settled on
Canton). The UI → backend call is an ordinary web request.

## Flow

```
UI  ──apply──▶  mortgage-backend ──GET /v1/credit-score──▶  credit-bureau
                       │                                        │ 402  (0.05 CC)
                       │◀───────────────── 402 ─────────────────┘
                       │ CantonX402Payer signs a 0.05 CC transfer
                       │──── retry with X-PAYMENT header ──────▶ verify + settle (facilitator)
                       │◀──── 200 report + X-PAYMENT-RESPONSE ───┘
                       │ apply lending policy (score / LTV)
UI ◀── decision + on-chain receipt (updateId) ──┘
```

## Prerequisites

- A reachable **facilitator** (`FACILITATOR_URL`) with a **merchant API key**
  (`FACILITATOR_API_KEY`) mapped to `BUREAU_PARTY` (the bureau must be an allowed `payTo`).
  External users target **DevNet** (the facilitator is a blackbox).
- A **funded payer party** with its Ed25519 key (`PAYER_PARTY_ID` / `PAYER_PUBLIC_KEY` /
  `PAYER_PRIVATE_KEY`, base64), reachable via a participant Ledger API (`LEDGER_CLIENT_URL`)
  whose OAuth the wallet-sdk can use.
  - **LocalNet:** run the facilitator's LocalNet stack, then let the bootstrap script below
    onboard + fund a payer party and provision the bureau — it writes `.env` for you.
  - **DevNet:** a funded party's exported key + your DevNet participant URL + OAuth client
    credentials (`CANTON_OAUTH_CLIENT_ID` / `_SECRET`).
- `AMULET_REGISTRY_URL` — the Token Standard registry (validator scan-proxy) for the network.

## Run — LocalNet (dev scripts)

Assumes the facilitator's LocalNet stack + facilitator are running (facilitator in
`FACILITATOR_MODE=single-tenant`, so no merchant API key is needed).

```bash
pnpm install                       # from the repo root
pnpm -r --filter "./packages/*" build

# 1. Provision a funded payer + the bureau on LocalNet and write examples/mortgage/.env.
#    Self-contained (pure Node) — talks to the LocalNet validator/ledger on localhost.
node examples/mortgage/scripts/bootstrap-localnet.mjs

# 2. Start the three apps (three terminals, or use &):
pnpm --filter @chainsafe/x402-example-mortgage-bureau  dev
pnpm --filter @chainsafe/x402-example-mortgage-backend dev
pnpm --filter @chainsafe/x402-example-mortgage-ui      dev
# open http://localhost:5173  (default SSN 888-77-6666 underwrites to APPROVED)
```

Quick checks without the UI (after the bootstrap + the apps are running):

```bash
curl "http://localhost:4001/v1/credit-score?subject=cust_1042"          # → 402 { accepts: [...] }
curl -XPOST localhost:4002/apply -H 'content-type: application/json' \
  -d '{"name":"Ada Lovelace","ssn":"888-77-6666","propertyPrice":500000,"loanAmount":400000}'  # → 200 { decision, credit, payment.updateId }
```

> **LocalNet provisioning** is what `bootstrap-localnet.mjs` handles: it discovers the
> synchronizer/DSO, onboards a funded payer external party + a receivable bureau party via
> the validator admin API (unsafe self-signed auth), and writes the `.env`. On **DevNet** you
> instead bring your own funded party (its exported key + participant URL + OAuth) and copy
> `.env.example` → `.env` by hand.

## Run — docker-compose

Images build from the monorepo root (the apps depend on the workspace packages). The UI's
nginx proxies `/api` → the backend; the backend reaches the bureau by service name.

**DevNet** (base compose — the apps reach the facilitator/participant over public URLs from
`.env`):

```bash
cp examples/mortgage/.env.example examples/mortgage/.env   # NETWORK=devnet, real FACILITATOR_URL, participant, OAuth, funded party key
cd examples/mortgage
docker compose up --build
# open http://localhost:5173
```

**LocalNet** (add the overlay — joins the LocalNet `localnet` docker network so the
containers reach `canton` / `splice` / `x402-facilitator` by service name; requires the
facilitator LocalNet stack running):

```bash
cd examples/mortgage
node scripts/bootstrap-localnet.mjs   # provision parties + write .env (once)
docker compose -f docker-compose.yml -f docker-compose.localnet.yml up --build
# open http://localhost:5173
```

## Configuration

Every setting is env-driven — see [`.env.example`](./.env.example) for the full list and
per-network notes. Highlights: `NETWORK`, `FACILITATOR_URL` / `FACILITATOR_API_KEY`,
`BUREAU_PARTY`, `LEDGER_CLIENT_URL`, `PAYER_*`, `AMULET_REGISTRY_URL`, `PRICE_CC`, and the
lending policy (`APPROVE_MIN_SCORE`, `MAX_LOAN`, `MAX_LTV`).

> Credit scores are **synthetic + deterministic** (derived from the applicant's SSN), so the
> demo is reproducible with no external data source. Amounts are USD labels; settlement is
> always Canton Coin.

## Notes / gotchas (learned running this on LocalNet)

- **Large `X-PAYMENT` header.** The Canton payment payload (prepared-tx blob + disclosed
  contracts) is tens of KB, well past Node's default 16 KB header limit — so a merchant
  server **must** raise `maxHeaderSize` or it rejects the paid request with **431**. The
  bureau does this via `http.createServer({ maxHeaderSize })` (see `credit-bureau/src/server.ts`).
- **x402-core version alignment.** The payer and the facilitator must speak the same
  `x402-core` payload contract. A facilitator built against an older `x402-core` rejects a
  newer payload with `scheme_mismatch` at `/v2/verify`. Ensure the deployed facilitator runs
  an `x402-core` compatible with the SDK version you install.
