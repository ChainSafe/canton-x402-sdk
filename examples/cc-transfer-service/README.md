# CC Transfer Service

REST API to execute Canton Coin transfers on the ledger.

## Usage

```bash
# Terminal 1: Start server
npm install && npm run server

# Terminal 2: Run client
npm run client
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/transfer` | Execute CC transfer `{from, to, amount}` |
| GET | `/transfers/:txId` | Look up transfer by transaction ID |

## What it demonstrates

- `settleLocal()` for direct Canton ledger settlement
- `CantonJsonClient.getTransactionById()` for querying transactions
- Real CC transfers between parties on cn-quickstart
