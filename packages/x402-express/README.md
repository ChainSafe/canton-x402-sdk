# @chainsafe/x402-express

Express middleware for [x402](https://x402.org) payments on the Canton Network.
`paymentRequired()` gates a route: it answers `402 Payment Required` with the
`PaymentRequirements` when a request is unpaid, verifies the payment against a
facilitator (optionally settling it on-ledger), and lets paid requests through
with the verified payer attached to `req.x402`.

Depends only on [`@chainsafe/x402-core`](../x402-core) (wire types) and
[`@chainsafe/x402-client`](../x402-client) (the facilitator client). Ships dual
ESM + CJS, so it works in both `import` and classic `require()` Express apps.

## Install

```bash
npm install @chainsafe/x402-express @chainsafe/x402-client express
```

## Usage

```ts
import express from "express";
import { FacilitatorClient } from "@chainsafe/x402-client";
import { paymentRequired } from "@chainsafe/x402-express";

const app = express();

// Construct the facilitator client once (Authorization: Bearer <apiKey>) and
// share it across as many paymentRequired() mounts as you like.
const facilitator = new FacilitatorClient("https://x402.example.com", {
  apiKey: process.env.FACILITATOR_API_KEY!,
});

app.use(
  "/paid",
  paymentRequired({
    facilitator,
    settle: true, // capture the payment after a valid verify (default: false)
    // Any field below can also be a (req) => value resolver.
    requirements: {
      network: "canton:devnet",
      payTo: "merchant::1220…",
      asset: { instrumentId: { id: "Amulet", admin: "DSO::1220…" } },
      amount: "500000000", // atomic units: 1 CC = 1e10, so this is 0.05 CC
    },
  }),
);

app.get("/paid", (req, res) => {
  // Reached only on a verified payment.
  res.json({ message: "Thanks!", payer: req.x402!.payer });
});
```

### CommonJS

```js
const { paymentRequired } = require("@chainsafe/x402-express");
```

## How it works

1. **Unpaid request** (no/invalid `X-PAYMENT`) → `402` with
   `{ x402Version: 2, accepts: [requirements] }`. Requirements are built from your
   options, with the defaults filled in.
2. **Paid request** → the `X-PAYMENT` header is decoded to a payment, which carries
   the requirements it was built against as `accepted`. Those are checked against
   your policy, then sent to the facilitator's `/v2/verify`.
3. On a valid verify (and a successful `/v2/settle` when `settle: true`), the
   payer is attached to `req.x402` and `next()` is called. Settlement's ledger
   transaction id is returned in the `X-PAYMENT-RESPONSE` response header.

Verification uses the requirements the payment carries as **`accepted`**, not
freshly-rebuilt ones, since a memo is issued per challenge and the payer signed
the one it was quoted. They are not signed: the signed transfer is checked
against them. They are validated against merchant policy before use: the scheme,
network, `payTo`, resource, asset and `maxTimeoutSeconds` must be this request's
terms, and the amount must not be under the price. Other fields (`description`,
and the `extra` keys beyond the instrument, `memo` and `executeBeforeSeconds`
among them) are not compared, and reach the facilitator as the payer sent them.
A header in the pre-spec `{ payment, requirements }` shape, a payment with no
`accepted`, or one whose `accepted` is not a whole `PaymentRequirements` (one of
`scheme`, `network`, `amount`, `asset` and `payTo` missing or empty, or a
`maxTimeoutSeconds` that is not a whole number of at least 1), is
`bad_payload`. Amounts are atomic units throughout — the same unit the wire
carries.

## Options

| Option | Description |
| --- | --- |
| `facilitator` | A `FacilitatorClient` (from `@chainsafe/x402-client`) used to verify/settle. Construct it with the facilitator URL + API key. |
| `settle` | Capture via `/v2/settle` after verify. Default `false`. |
| `requirements` | How to produce the `PaymentRequirements`: a **spec** or a **builder** (see below). |
| `additionalAccepts` | `(req) => CantonPaymentRequirements[]` extra `accepts[]` entries (e.g. an alternate scheme). |
| `onReject` | `(rejection, req) => void`, called when a presented payment is rejected (402) or the facilitator/middleware fails (502/500). Receives `{ status, reason, details?, extensions?, error? }`, where `extensions` is the facilitator's full verify detail. May be async; a throw or rejection is swallowed. The middleware logs nothing on its own, e.g. `onReject: (r) => console.warn("x402 rejected", r)`. |

### `requirements`

Either a **declarative spec** — `{ payTo, asset, network, amount, scheme?, resource?, description?, maxTimeoutSeconds?, executeBeforeSeconds?, memo? }`, where the middleware fills in `maxTimeoutSeconds` (default 60), `extra.assetTransferMethod` and `extra.executeBeforeSeconds` (default 120), and every field may be a fixed value **or** a `(req) => value` resolver — or a **builder** `(req) => CantonPaymentRequirements` for full control (you own `maxTimeoutSeconds` and the whole of `extra`).

`memo` is special: it's a **function only** (`(req) => string | Promise<string>`), called once per challenge, so a merchant can generate *and record* it (e.g. an order id persisted for reconciliation). Omit it to quote none. Quoting one **binds** it — the payer must sign the identical value into the transfer.

That proves less than it looks, though: the scheme compares the transfer against the requirements the **payer** echoed, so a payer can echo no memo and sign none, or echo any value and sign that. The middleware keeps no record of what it issued, so it cannot tell. If you reconcile *on* the memo, use `checkPayment` — your own say on a paid request, with everything the payer sent, run after merchant policy and **before verify, so before any settle**. Return a short reason to refuse (answered as a 402 carrying that code), or nothing to accept:

```ts
checkPayment: async ({ requirements }) => {
  const order = await orders.findByRef(requirements.extra.memo);
  if (!order) return "policy_memo_unknown";
  if (order.status !== "awaiting-payment") return "policy_order_closed";
},
```

It is not memo-specific — it is where any check needing your own records belongs.

## `req.x402`

On a paid request the middleware attaches:

```ts
req.x402 = {
  payer: string; // the signed transfer's sender: the facilitator's verify.payer, or read from the payload
  requirements: CantonPaymentRequirements;
  payload: CantonPaymentPayload;
  verify: VerifyResponse;
  settle?: SettleResponse; // present when settle: true
};
```
