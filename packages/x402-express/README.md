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
      payTo: "merchant::1220…",
      amount: "500000000", // atomic units: 1 CC = 1e10, so this is 0.05 CC
      // `network` and `asset` are read from the facilitator's /v2/supported.
      // Set them to pin them yourself.
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
   `{ x402Version: 2, accepts: [...] }`: your quote, plus any
   `additionalAccepts` entries, with the defaults filled in. A `memo` generator
   is called here, and only here.
2. **Paid request** → the `X-PAYMENT` header is decoded to a payment payload
   plus the requirements it was signed against. The middleware works out which
   of the quotes it would advertise that payment is for, holds it against that
   one, then sends it to the facilitator's `/v2/verify`.
3. On a valid verify (and a successful `/v2/settle` when `settle: true`), the
   payer is attached to `req.x402` and `next()` is called. Settlement's ledger
   transaction id is returned in the `X-PAYMENT-RESPONSE` response header.

The decoded header is **guarded before anything reads a field off it**. The
`X-PAYMENT` envelope is a loose object — `payload.payload` is `{}` as far as it
is concerned, and `extra` is not required at all — so the scheme's
`acceptsPayload` and `acceptsRequirements` are the only things that have checked
what someone else sent. A header failing either is a `402`
(`policy_payload_invalid` / `policy_requirements_invalid`) and costs no verify.

Verification uses the requirements the client **echoes** in `X-PAYMENT`, not
freshly-rebuilt ones: the payer signed a transfer against *those*, and the
scheme's job is to check the signed transfer against them. They are not
themselves signed, which is why they are first held against your own terms —
`scheme`, `network`, `payTo`, `resource`, the instrument (not just its symbol),
the quoted `executeBeforeSeconds`, and an amount that is not under the price.

Each field is classified once, in a table keyed off a schema's own entries — the
common fields in the middleware, `extra` in the scheme adapter — so a field
added to either fails the build until someone decides what comparing it means
rather than going unchecked. `description` and `maxTimeoutSeconds` are
deliberately not compared: neither reaches the ledger. Nor is `memo`: the
middleware keeps no record of what it issued, so only your `checkPayment` can
judge it.

Amounts are atomic units throughout — the same unit the wire carries.

Rejections answer `402` with a **fresh** challenge, never the echoed
requirements the payer just failed on, so a retrying agent is handed terms it
can actually pay.

## Another scheme

Canton's `exact` is the default and needs no wiring, but nothing in the
middleware is canton-shaped. It owns the HTTP flow and the fields x402 v2 gives
every scheme — `scheme`, `network`, `payTo`, `resource`, `asset`, `amount`,
`description`, `maxTimeoutSeconds`. A **scheme adapter** owns `extra`:

```ts
interface SchemeAdapter<TSpec, TRequirements, TPayload> {
  id: string;
  // The only things that have checked a header someone else sent.
  acceptsRequirements(r: X402PaymentRequirements<unknown>): r is TRequirements;
  acceptsPayload(p: X402PaymentPayload<unknown>): p is TPayload;
  // How each field of `extra` is held against the merchant's.
  extraRules: RuleTable;
  // Build the scheme's part of a quote, including its per-challenge reference.
  quote(req, spec: TSpec, ctx): Promise<SchemeQuote>;
}
```

`quote()` returns the `scheme`, `network` and `asset` to advertise, the `extra`
to carry, and optionally a `mintReference()` the middleware calls **only when it
issues a challenge** — the same once-per-challenge discipline canton-exact's
`memo` gets, under whatever key your scheme uses.

```ts
app.use("/paid", paymentRequired<VoucherSpec, VoucherRequirements, VoucherPayload>({
  facilitator,
  scheme: voucherScheme,
  requirements: { payTo: "shop::1", amount: "10", book: "autumn-2026" },
}));
```

`req.x402` is typed for the default scheme; `X402RequestState<TRequirements,
TPayload>` is exported for a route gated on another.

## Options

| Option | Description |
| --- | --- |
| `facilitator` | A `FacilitatorClient` (from `@chainsafe/x402-client`) used to verify/settle. Construct it with the facilitator URL + API key. |
| `scheme` | The payment scheme to gate on. Default `cantonExact` — Canton's registered `exact`. See [Another scheme](#another-scheme). |
| `settle` | Capture via `/v2/settle` after verify. Default `false`. |
| `requirements` | How to produce the `PaymentRequirements`: a **spec** or a **builder** (see below). |
| `additionalAccepts` | `(req) => CantonPaymentRequirements[]` extra `accepts[]` entries (e.g. an alternate scheme). A payer may pay any of them — the middleware works out which advertised quote a payment is for and holds it against that one. Runs on every request, so keep it side-effect-free. |
| `onReject` | `(rejection, req) => void`, called when a presented payment is rejected (402) or the facilitator/middleware fails (502/500). Receives `{ status, reason, details?, extensions?, error? }`, where `extensions` is the facilitator's full verify detail. May be async; a throw or rejection is swallowed. The middleware logs nothing on its own, e.g. `onReject: (r) => console.warn("x402 rejected", r)`. |

### `requirements`

Either a **declarative spec** — `{ payTo, amount, network?, asset?, instrument?, scheme?, resource?, description?, maxTimeoutSeconds?, executeBeforeSeconds?, memo? }`, where the middleware fills in `maxTimeoutSeconds` (default 60), `extra.assetTransferMethod` and `extra.executeBeforeSeconds` (default 120), and every field may be a fixed value **or** a `(req) => value` resolver — or a **builder** `(req) => CantonPaymentRequirements` for full control (you own `maxTimeoutSeconds` and the whole of `extra`).

Only `payTo` and `amount` are required. Leave out `network` and `asset` and the middleware reads them from the facilitator's `GET /v2/supported`: the network it settles, and the instrument with the registry party it validates holdings against. That party is then read from the service doing the validating, instead of living as a second copy in your config. The response is cached by `FacilitatorClient` (`supportedTtlMs`, default 5 minutes), so this is one round trip per TTL and none at all if you pin both fields.

If your facilitator settles more than one network or instrument, name the one you want (`network`, or `instrument` for an instrument's `id`) — otherwise it is an error rather than a guess, because choosing for you would be choosing what you charge.

A **builder** runs on every request, paid ones included, because a payment has to be held against your terms and only the builder knows them. Keep it side-effect-free, and use `memo` for anything that should happen once per challenge.

`memo` is special: it's a **function only** (`(req) => string | Promise<string>`), called once per challenge **issued** — on the 402 that offers terms, and not on a request that pays terms already offered — so a merchant can generate *and record* it (e.g. an order id persisted for reconciliation) without a successful payment booking a second one. Omit it to quote none. Quoting one **binds** it — the payer must sign the identical value into the transfer.

That proves less than it looks, though: the scheme compares the transfer against the requirements the **payer** echoed, so a payer can echo no memo and sign none, or echo any value and sign that. The middleware keeps no record of what it issued, so it cannot tell. If you reconcile *on* the memo, use `checkPayment` — your own say on a paid request, with everything the payer sent, run after merchant policy and **before verify, so before any settle**. Return a short reason to refuse (answered as a 402 carrying that code), or nothing to accept:

```ts
checkPayment: async ({ payload, requirements }) => {
  const order = await orders.findByRef(requirements.extra.memo);
  if (!order) return "policy_memo_unknown";
  if (order.status !== "awaiting-payment") return "policy_order_closed";
  if (!(await allowed(payload.payload.payer))) return "policy_payer_blocked";
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
