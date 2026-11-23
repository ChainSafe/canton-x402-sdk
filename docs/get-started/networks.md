---
description: The x402 facilitator on Canton DevNet and MainNet — each network's facilitator URL and merchant dashboard, and what it settles.
---

# Networks

The x402 facilitator is live on Canton **DevNet** and **MainNet**. Build and
test on DevNet, then move to MainNet: the integration stays the same, pointed at
the MainNet facilitator with a MainNet API key and Canton parties.

|              | DevNet                                                                     | MainNet                                                            |
| ------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Facilitator  | `https://dev-api-x402.chainsafe.io`                                        | `https://api-x402.chainsafe.io`                                    |
| Dashboard    | [dev-dashboard-x402.chainsafe.io](https://dev-dashboard-x402.chainsafe.io) | [dashboard-x402.chainsafe.io](https://dashboard-x402.chainsafe.io) |
| Network id   | `canton:devnet`                                                            | `canton:mainnet`                                                   |
| Payer preset | `devnetConfig`                                                             | `mainnetConfig`                                                    |
| Asset        | Canton Coin (CC)                                                           | Canton Coin (CC)                                                   |

Each network is its own deployment, with its own dashboard, account and API
keys: a key created on the DevNet dashboard is for the DevNet facilitator only.

## What a facilitator settles

[`GET /v2/supported`](/reference/http-api#get-v2-supported) is the authority on
what a facilitator accepts. It needs no API key:

```bash
curl -sS https://dev-api-x402.chainsafe.io/v2/supported
```

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "canton:devnet",
      "extra": {
        "transferMethods": ["transfer-factory"],
        "synchronizerId": "global-domain::1220be58c29e…",
        "carriages": ["inline"],
        "instruments": [
          {
            "admin": "DSO::1220be58c29e…",
            "instrumentId": { "id": "Amulet", "admin": "DSO::1220be58c29e…" },
            "symbol": "CC"
          }
        ],
        "feePayer": "x402-facilitator::1220096316d4…"
      }
    }
  ],
  "extensions": [],
  "signers": { "canton:*": ["x402-facilitator::1220096316d4…"] }
}
```

The synchronizer, the party that relays payments (`feePayer`) and each
instrument's admin are the facilitator's own facts, so you never configure
them: the `x402-express` middleware reads them from here and caches them, and a
payer takes the instrument admin from `instruments[].instrumentId.admin`. The
values differ between networks, which is why the docs never hard-code them.

## Moving to MainNet

The same integration, pointed at MainNet:

- **Merchant** — sign in to the
  [MainNet dashboard](https://dashboard-x402.chainsafe.io), link your MainNet
  payout party (it needs a live `TransferPreapproval`, as on DevNet), create a
  MainNet API key, and set `FACILITATOR_URL` to `https://api-x402.chainsafe.io`.
- **Payer** — build the payer with `mainnetConfig` instead of `devnetConfig`,
  against your MainNet participant and its Amulet registry, from a MainNet
  party funded with Canton Coin.

::: tip Next
[Accept payments](/get-started/accept-payments) or
[Pay for an API](/get-started/pay-for-an-api) walks the integration itself.
:::
