# canton-x402-sdk

TypeScript SDK for x402 payments on Canton Network. Drop payment gating into any Express app with two lines of code. Settles real Daml transactions on the Canton ledger via the JSON API v2.

## Current Status

- Real Canton Coin (CC) transfers via `settleLocal()` (localnet) and `settle()` (devnet/mainnet)
- `paymentRequired()` middleware — gate any Express route behind a CC payment
- `createFacilitatorRouter()` — embeddable facilitator with settle, verify, transaction lookup
- `createX402Fetch()` — client-side fetch wrapper that auto-handles 402 payment flows
- Three working example apps with inline web UIs:
  - **Token-Gated Docs** (`:4010`) — pay 0.10 CC to view financial documents
  - **CC Transfer Service** (`:4020`) — execute transfers with receipt cards and transfer log
  - **Balance Inquiry** (`:4030`) — query Canton Coin holdings for any party
- Clickable transaction IDs — click any Tx ID to drill into full Canton ledger details (events, choice arguments, witness parties)
- Shared-secret auth (localnet) and OAuth2 client-credentials (devnet/mainnet)
- Ed25519 interactive submission signing for devnet/mainnet

## Architecture

```
                      +-----------------------+
                      |   Resource Server     |
                      |  (your Express app)   |
                      |                       |
   Client --GET-->    |  paymentRequired()    | --> 402 + requirements
   Client --GET-->    |  (X-PAYMENT header)   | --> verify --> 200 + resource
                      |                       |
                      |  /facilitator (router) | --> verify, settle, transaction lookup
                      +-----------------------+
                               |
                      +--------v----------+
                      |  Canton Ledger    |
                      |  JSON API v2      |
                      +-------------------+
```

## Build & Run

### Prerequisites

1. **cn-quickstart** running (provides Canton participant nodes + Keycloak):
   ```bash
   cd ~/chainsafe/cn-quickstart/quickstart && make start
   ```

2. **Tap CC** at `http://wallet.localhost:2000` for the app-user party (~1 CC minimum)

### Build the SDK

```bash
cd canton-x402-sdk
npm install
npm run build
```

### Setup examples (generates .env files with party IDs from your running Canton node)

```bash
cd examples/shared && npx tsx setup.ts
```

### Run all examples

```bash
bash examples/start-all.sh
```

Or individually:

```bash
npx tsx examples/token-gated-docs/src/server.ts      # :4010
npx tsx examples/cc-transfer-service/src/server.ts    # :4020
npx tsx examples/balance-inquiry/src/server.ts        # :4030
```

## Drop-In Integration Guide

Adding x402 payment gating to your Express app takes 3 steps:

### Step 1: Install

```bash
npm install canton-x402-sdk
```

### Step 2: Mount the facilitator

```typescript
import express from "express";
import { createFacilitatorRouter, paymentRequired, localnetConfig } from "canton-x402-sdk";

const app = express();
app.use(express.json());

// Configure for your Canton environment
const config = localnetConfig({ dsoParty: "DSO::122..." });

// One line — mounts /facilitator/settle, /facilitator/verify, /facilitator/transaction/:id, etc.
app.use("/facilitator", createFacilitatorRouter({ config }));
```

### Step 3: Protect any route

```typescript
const PAYEE = "app_provider_quickstart-skynet-1::1220...";

app.get("/premium-content", paymentRequired({
  payTo: PAYEE,
  amount: "0.10",                                    // price in CC
  facilitatorUrl: "http://localhost:3000/facilitator", // points to the router you mounted
  description: "Access to premium content",
}), (req, res) => {
  // This handler only runs after payment is verified
  res.json({ content: "You paid for this!" });
});
```

That's it. The middleware handles the full flow:
1. First request (no payment) -> returns `402 Payment Required` with payment requirements
2. Client settles on Canton ledger -> gets transaction ID
3. Client retries with `X-PAYMENT` header -> middleware verifies -> `200` with content

### Client-Side (auto-pay)

```typescript
import { createX402Fetch } from "canton-x402-sdk";

const x402Fetch = createX402Fetch({ config, payerParty: "app_user_quickstart..." });
const res = await x402Fetch("http://localhost:3000/premium-content");
// Automatically handles 402 -> settle -> retry
```

### Direct Transfers (no middleware)

```typescript
import { createAuthProvider, CantonJsonClient, settleLocal } from "canton-x402-sdk";

const auth = createAuthProvider(config.auth);
const client = new CantonJsonClient(config.ledgerApiUrl, auth);

const result = await settleLocal(
  { payerParty: sender, payeeParty: receiver, amount: "0.50", resourceId: "my-transfer" },
  config,
  client,
  auth,
);
console.log("Transaction ID:", result.transactionId);
```

## SDK Entry Points

```typescript
// Main — everything from one import
import { localnetConfig, paymentRequired, createX402Fetch, createFacilitatorRouter, settleLocal } from "canton-x402-sdk";

// Sub-paths for tree-shaking
import { paymentRequired } from "canton-x402-sdk/middleware";
import { createX402Fetch } from "canton-x402-sdk/client";
import { createFacilitatorRouter } from "canton-x402-sdk/facilitator";
import { CantonJsonClient, settleLocal, settle } from "canton-x402-sdk/canton";
```

## Configuration

| Setting | Localnet (cn-quickstart) | DevNet |
|---------|--------------------------|--------|
| Auth | HS256 shared-secret (`"unsafe"`) | OAuth2 client_credentials |
| Ledger API | `http://localhost:2975` | ChainSafe DevNet endpoint |
| Scan Proxy | `http://scan.localhost:4000` | ChainSafe validator scan |
| Network | `canton-local` | `canton-devnet` |
| Settlement | Direct JSON API submission | Interactive + Ed25519 signing |

```typescript
import { localnetConfig, devnetConfig } from "canton-x402-sdk";

const config = localnetConfig({ dsoParty: "DSO::..." });
// or
const config = devnetConfig();
```

## Facilitator Endpoints

When you mount `createFacilitatorRouter()`, these endpoints are available:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/supported` | GET | List supported payment schemes and networks |
| `/verify` | POST | Validate a payment payload (client-side checks) |
| `/settle` | POST | Execute a Canton Coin transfer on the ledger |
| `/payment-object` | POST | Generate a payment object with TransferFactory |
| `/verify-payment` | POST | Verify a transaction on-chain by querying the ledger |
| `/check-payment-status` | GET | Check if a payment was already made |
| `/transaction/:id` | GET | Fetch full transaction details from Canton ledger |
| `/health` | GET | Health check (Canton connectivity) |

## API Reference

### `paymentRequired(options)`

Express middleware. Returns 402 if no payment header, verifies payment if present.

| Option | Type | Description |
|--------|------|-------------|
| `payTo` | `string` | Payee party ID |
| `amount` | `string` | Price in CC |
| `facilitatorUrl` | `string` | URL of facilitator (can be embedded) |
| `network` | `string?` | Default: `"canton-local"` |
| `description` | `string?` | Human-readable description |
| `getPrice` | `(req) => string` | Dynamic pricing function |

### `createX402Fetch(options)`

Returns a fetch-compatible function that auto-handles 402 responses.

| Option | Type | Description |
|--------|------|-------------|
| `config` | `CantonSdkConfig` | SDK configuration |
| `payerParty` | `string` | Payer party ID |
| `privateKey` | `string?` | Ed25519 key (devnet only) |
| `keyFingerprint` | `string?` | Key fingerprint (devnet only) |

### `settleLocal(options, config, client, auth)`

Direct settlement via JSON API v2 (localnet). Returns `{ success, transactionId }`.

### `settle(options, config, client, auth)`

Interactive settlement with Ed25519 signing (devnet/mainnet). Returns `{ success, transactionId }`.

### `createFacilitatorRouter(options)`

Returns an Express Router with all facilitator endpoints.

## License

Apache-2.0
