# Deploy on Google Cloud (martin@chainsafe.io)

**WebAuthn does not run on GCS.** GCS is for static files only. The stack is:

| Piece | GCP product |
| --- | --- |
| React UI (built `web/dist`) | **Cloud Storage** bucket + HTTPS load balancer, or **Firebase Hosting** |
| Gateway (Google OAuth, sessions, WebAuthn, rate limits, pay proxy) | **Cloud Run** |
| User / passkey data (demo) | file on Cloud Run volume or **Firestore** later |

## 1. Google Cloud project

1. Sign in at [console.cloud.google.com](https://console.cloud.google.com) with **martin@chainsafe.io**.
2. Create or pick a project (your CLI already had `revstackfactory`; use a dedicated project if you prefer).
3. Enable **Google Identity** for sign-in: **APIs & Services → OAuth consent screen** (Internal or External test users).
4. **Credentials → Create credentials → OAuth client ID → Web application**
   - **Authorized JavaScript origins:** `http://localhost:5180`, `https://YOUR_DOMAIN`
   - **Authorized redirect URIs:** `http://localhost:5180/gateway/auth/google/callback`, `https://YOUR_DOMAIN/gateway/auth/google/callback`
5. Copy **Client ID** and **Client secret** into `examples/one-job-apis/gateway/.env`.

## 2. WebAuthn and your domain

Passkeys bind to **rpId** = your site hostname (no port).

- Local dev: `WEBAUTHN_RP_ID=localhost`, `WEBAUTHN_ORIGIN=http://localhost:5180`
- Production: `WEBAUTHN_RP_ID=onejob.example.com`, `WEBAUTHN_ORIGIN=https://onejob.example.com`

The UI and OAuth redirect must use the same origin the user sees in the browser.

## 3. Run locally (three processes)

```bash
corepack pnpm --filter @chainsafe/x402-example-one-job-api dev
cp examples/one-job-apis/gateway/.env.example examples/one-job-apis/gateway/.env
# fill GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, or set ALLOW_DEV_LOGIN=1
corepack pnpm --filter @chainsafe/x402-example-one-job-gateway dev
corepack pnpm --filter @chainsafe/x402-example-one-job-web dev
```

Vite proxies `/gateway` → gateway and `/api` → merchant.

## 4. Cloud Run (gateway)

Build a container from `examples/one-job-apis/gateway` (Dockerfile can be added in a follow-up). Set env:

- `PUBLIC_ORIGIN`, `MERCHANT_URL` (merchant URL on another Cloud Run or VM)
- `GOOGLE_CLIENT_*`, `SESSION_SECRET`, `WEBAUTHN_*`, `DAILY_SPEND_CAP_CENTS`
- `NODE_ENV=production` (secure cookies)

Put the service behind the same domain as the UI (path `/gateway` or a subdomain with CORS + cookies planned carefully). Easiest demo: **one** Cloud Run that serves UI static files and mounts gateway routes.

## 5. GCS (static UI)

```bash
corepack pnpm --filter @chainsafe/x402-example-one-job-web build
gsutil mb -p YOUR_PROJECT gs://YOUR_BUCKET
gsutil -m rsync -r examples/one-job-apis/web/dist gs://YOUR_BUCKET
```

Point HTTPS load balancer at the bucket. Do **not** expect passkeys or OAuth from `storage.googleapis.com` URLs alone — users must load the SPA on **your** domain with the gateway on the same site (or configured cookie/proxy plan).

## 6. What is still demo vs real CC

The gateway still uses the merchant’s **stand-in** signer until you configure `CantonX402Payer` + DevNet keys on the gateway. WebAuthn is real; the ledger step is the next swap.