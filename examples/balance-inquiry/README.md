# Balance Inquiry API

Pay-per-query endpoint returning Canton Coin holdings for a party.

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
| GET | `/balance/:party` | 0.05 CC | Query CC holdings |
| GET | `/health` | Free | Health check |

## What it demonstrates

- `paymentRequired()` gating a data query
- `CantonJsonClient.getPayerHoldings()` reading from the ledger
- Data-feed monetization pattern (pay-per-query)
