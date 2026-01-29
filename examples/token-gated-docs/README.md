# Token-Gated Document Access

Pay 0.10 CC per download to access signed financial documents (term sheets, trade confirmations).

## Usage

```bash
# Terminal 1: Start server
npm install && npm run server

# Terminal 2: Run client
npm run client
```

## Endpoints

| Method | Path | Price | Description |
|--------|------|-------|-------------|
| GET | `/docs` | Free | List available documents |
| GET | `/docs/:id` | 0.10 CC | Download a document |

## What it demonstrates

- `paymentRequired()` middleware gating a resource
- `createFacilitatorRouter()` embedded in the server
- `createX402Fetch()` auto-handling 402 on the client
