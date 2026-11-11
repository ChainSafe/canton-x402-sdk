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
      accepts: [
        { amount: "500000000", asset: "Amulet" }, // atomic units: 1 CC = 1e10
      ],
      // `asset` names the instrument; its registry party and the `network`
      // are read from the facilitator's /v2/supported. Pin them yourself by
      // setting `network`, and `asset: { instrumentId: { id, admin } }`.
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

1. **Unpaid request** (no payment, or an invalid one) → `402` with the spec's
   `PaymentRequired`, `{ x402Version: 2, resource, accepts: [...] }`, base64-encoded
   in the `PAYMENT-REQUIRED` header and as the body. One `accepts[]` entry per
   way to pay, with the defaults filled in, and `resource` is the URL and
   description they were quoted for. A `memo` generator is called here, and
   only here — once per challenge for the entries sharing it.
2. **Paid request** → the `PAYMENT-SIGNATURE` header is decoded to a payment,
   which carries the requirements it was built against as `accepted`. The
   middleware works out which of the quotes it would advertise that payment is
   for, holds it against that one, then sends it to the facilitator's
   `/v2/verify`. `X-PAYMENT`, the name this SDK used before the spec's, is still
   read when `PAYMENT-SIGNATURE` is absent or empty, though only for a payment
   of this shape: a 0.1.x payer sends the older one, which is `bad_payload`
   either way.
3. On a valid verify (and a successful `/v2/settle` when `settle: true`), the
   payer is attached to `req.x402` and `next()` is called. Settlement's ledger
   transaction id is returned in the `X-PAYMENT-RESPONSE` response header.

A browser page on another origin can read `PAYMENT-REQUIRED` and
`X-PAYMENT-RESPONSE` only if your CORS setup lists them in
`Access-Control-Expose-Headers`, and can send `PAYMENT-SIGNATURE` only if the
preflight allows it in `Access-Control-Allow-Headers`.

A header in the pre-spec `{ payment, requirements }` shape, a payment with no
`accepted`, or one whose `accepted` is not a whole `PaymentRequirements` (one of
`scheme`, `network`, `amount`, `asset` and `payTo` missing or empty, or a
`maxTimeoutSeconds` that is not a whole number of at least 1), is `bad_payload`
— the codec refuses it before the middleware reads anything.

The decoded header is **guarded before anything reads a field off it**. The
payment envelope is a loose object — `payload.payload` is `{}` as far as it
is concerned, and `extra` is not required at all — so the scheme's
`acceptsPayload` and `acceptsRequirements` are the only things that have checked
what someone else sent. A header failing either is a `402`
(`policy_payload_invalid` / `policy_requirements_invalid`) and costs no verify.

Verification uses the requirements the payment carries as **`accepted`**, not
freshly-rebuilt ones: the payer signed a transfer against *those*, and the
scheme's job is to check the signed transfer against them. They are not
themselves signed, which is why they are first held against your own terms —
`scheme`, `network`, `payTo`, the instrument (not just its symbol),
the quoted `executeBeforeSeconds`, `maxTimeoutSeconds`, and an amount that is
not under the price.

Each field is classified once, in a table keyed off a schema's own entries — the
common fields in the middleware, `extra` in the scheme adapter — so a field
added to either fails the build until someone decides what comparing it means
rather than going unchecked. `description` is deliberately not compared: it
does not reach the ledger. Nor is `memo`: the
middleware keeps no record of what it issued, so only your `preSettle` can
judge it.

Amounts are atomic units throughout — the same unit the wire carries.

Rejections answer `402` with a **fresh** challenge, never the echoed
requirements the payer just failed on, so a retrying agent is handed terms it
can actually pay.

## Another scheme

Canton's `exact` is the default and needs no wiring, but nothing in the
middleware is canton-shaped. It owns the HTTP flow and the fields x402 v2 gives
every scheme — `scheme`, `network`, `payTo`, `asset`, `amount` and
`maxTimeoutSeconds`. A **scheme adapter** owns `extra`:

```ts
interface SchemeAdapter<TSpec, TRequirements, TPayload> {
  id: string;
  // The only things that have checked a header someone else sent.
  acceptsRequirements(r: X402PaymentRequirements<unknown>): r is TRequirements;
  acceptsPayload(p: X402PaymentPayload<unknown>): p is TPayload;
  // Who paid, read from the payload when the facilitator does not say.
  payerOf(payload: TPayload): string | undefined;
  // How each field of `extra` is held against the merchant's.
  extraRules: RuleTable;
  // Build the scheme's part of a quote, including its per-challenge reference.
  quote(req, spec: TSpec, ctx): Promise<SchemeQuote>;
  // Optional. What makes one entry a distinct way to pay, and the code to
  // refuse with when no payer can be read.
  distinctKey?(spec: TSpec): string | undefined;
  unreadablePayerReason?: string;
}
```

`quote()` returns the `scheme`, `network` and `asset` to advertise, the `extra`
to carry, and optionally a `mintReference()` the middleware calls **only when it
issues a challenge** — the same once-per-challenge discipline canton-exact's
`memo` gets, under whatever key your scheme uses. A quote may also carry a
`referenceKey`: quotes sharing one (by identity) are issued a single reference
between them, so a 402 offering several ways to pay books one order rather than
one per entry.

```ts
app.use("/paid", paymentRequired<VoucherSpec, VoucherRequirements, VoucherPayload>({
  facilitator,
  scheme: voucherScheme,
  requirements: { payTo: "shop::1", accepts: [{ amount: "10", book: "autumn-2026" }] },
}));
```

The generic overload requires `scheme`, since that is what makes it another
scheme's route. Without one there is a single overload to satisfy — the default
canton-exact shapes — so an incomplete inline way to pay is a compile error
rather than something that infers its own type and fails at mount.

`req.x402` is typed for the default scheme; `X402RequestState<TRequirements,
TPayload>` is exported for a route gated on another.

## Options

| Option | Description |
| --- | --- |
| `facilitator` | A `FacilitatorClient` (from `@chainsafe/x402-client`) used to verify/settle. Construct it with the facilitator URL + API key. |
| `scheme` | The payment scheme to gate on. Default `cantonExact` — Canton's registered `exact`. See [Another scheme](#another-scheme). |
| `settle` | Capture via `/v2/settle` after verify. Default `false`. |
| `requirements` | How to produce the `PaymentRequirements`: a **spec** or a **builder** (see below). |
| `preSettle` | `(payment, req) => string \| undefined`, your own say on a verified payment, run after verify and before anything settles. Return a short reason to refuse it, or nothing to let it through; see below. |
| `onQuoteError` | `(error, req) => void`, called when a way to pay could not be quoted and was left out of the 402 — the facilitator no longer settles the instrument it names, say. The request is still answered from the entries that did quote, so without this a way to pay can disappear unnoticed. Fires once per dropped entry per request; a throw is swallowed. |
| `onReject` | `(rejection, req) => void`, called when a presented payment is rejected (402) or the facilitator/middleware fails (502/500). Receives `{ status, reason, details?, extensions?, error?, payment? }`, where `extensions` is the facilitator's full verify detail, with the code it answered with before the spec's in `extensions.reason`, and `payment` is the payload, requirements and payer this refusal is about, present only once `preSettle` has accepted it — see **Undoing it** under [`requirements`](#requirements). May be async; a throw or rejection is swallowed. The middleware logs nothing on its own, e.g. `onReject: (r) => console.warn("x402 rejected", r)`. |

### `requirements`

A 402 advertises **one resource and a list of ways to pay for it**, which is how x402 v2 §5.1.2 defines it — `PaymentRequirements` carries no resource of its own, and since #76 neither does ours. `resource` and `description` are named once, on the terms, and appear once, on the 402's top-level `resource`. No `accepts[]` entry repeats them. The config has the same shape:

```ts
requirements: {
  // the sale, named once
  payTo: "merchant::1220…",
  resource: "https://merchant.example/report",   // default: the request URL
  description: "Quarterly report",

  // the ways to pay, each advertised as one accepts[] entry
  accepts: [
    { amount: "500000000", asset: "Amulet" },   // 0.05 CC
    { amount: "250000", asset: "USDCx" },       // priced separately
  ],
}
```

Every entry is a spec, so each gets discovery and the defaults, and there is no privileged first entry. Any shared field except `resource` and `description` — which name the sale, not a way of paying for it — may be overridden per entry (a second instrument settling to a different party, say), and each entry carries its own price, because 0.05 of one token is not 0.05 of another and nothing here checks two entries are worth the same.

Per-entry fields are `{ amount, asset, executeBeforeSeconds?, memo? }` plus an override of any shared one but `resource` and `description`. Any of them may also be set **once at the top level**, beside `payTo`, and `memo` usually should be — see below. `amount` and `asset` are required on every entry regardless, so naming those at the top level does nothing. The middleware fills in `maxTimeoutSeconds` (default 60), `extra.assetTransferMethod` and `extra.executeBeforeSeconds` (default 120). Every field may be a fixed value **or** a `(req) => value` resolver.

For full control, a **builder** `(req) => CantonPaymentRequirements[]` returns the whole list and you own `maxTimeoutSeconds` and the whole of `extra`.

`payTo`, and each entry's `amount` and `asset`, are what you must give. `amount` is atomic units *of something*, so every way to pay says what — there is no deployment default to fall back on, and quoting one would be choosing what you charge.

`asset` takes either form. An **instrument id** — `"Amulet"` for Canton Coin, which is the one id that differs from its wire symbol (`"CC"`) — names the instrument and leaves the registry party to the facilitator's `GET /v2/supported`, so that party is read from the service doing the validating instead of living as a second copy in your config. The whole `{ instrumentId: { id, admin } }` pins it, admin included.

`network` is the one field discovery can supply on its own, and it is narrowed to the instrument the entry names, so the network quoted is one that settles it. Pin it to skip that. The `/v2/supported` response is cached by `FacilitatorClient` (`supportedTtlMs`, default 5 minutes), so discovery is one round trip per TTL and none at all when `network` and a whole `asset` are both pinned.

If more than one network settles the instrument, or the id the entry names is not one the deployment carries, that is an error rather than a guess — and the refusal lists what it does carry.

A **builder** runs on every request, paid ones included, because a payment has to be held against your terms and only the builder knows them. Keep it side-effect-free, and use `memo` for anything that should happen once per challenge.

`memo` is special: it's a **function only** (`(req) => string | Promise<string>`), called once per challenge **issued** — on the 402 that offers terms, and not on a request that pays terms already offered — so a merchant can generate *and record* it (e.g. an order id persisted for reconciliation) without a successful payment booking a second one. Omit it to quote none. Quoting one **binds** it — the payer must sign the identical value into the transfer.

**Write it once, in the shared terms**, if it books anything. A 402 is one sale however many ways it offers to pay for it, and entries carrying the *same function* are issued one reference between them. Two entries given the same body written out twice are two functions, so two references — and a generator that books an order books two, only one of which is ever paid:

```ts
requirements: {
  payTo: "merchant::1220…",
  memo: (req) => orders.open(req),  // once, for the sale
  accepts: [
    { amount: "500000000", asset: "Amulet" },
    { amount: "250000", asset: "USDCx" },
  ],
}
```

An entry naming its own `memo` overrides the shared one and gets its own reference, which is the merchant asking for that.

That proves less than it looks, though: the scheme compares the transfer against the requirements the **payer** echoed, so a payer can echo no memo and sign none, or echo any value and sign that. The middleware keeps no record of what it issued, so it cannot tell. If you reconcile *on* the memo, use `preSettle` — your own say on a payment the facilitator has verified, run **after verify and before any settle**. Return a short reason to refuse (answered as a 402 carrying that code), or nothing to accept:

```ts
preSettle: async ({ requirements, payer }) => {
  const order = await orders.findByRef(requirements.extra.memo);
  if (!order) return "policy_memo_unknown";
  if (order.status !== "awaiting-payment") return "policy_order_closed";
  if (!(await allowed(payer))) return "policy_payer_blocked";
},
```

**After verify, not before.** Running there means `requirements` has been held against the signed transfer, so a memo is one the payer committed to rather than one it claims — safe to reserve stock or mark an order claimed on. `payer` is the verified transfer's sender, and does not exist before this point: the payload names none.

**Undoing it.** Settle can still fail after `preSettle` has reserved something. `onReject` then receives `payment` — the payload, the requirements as `preSettle` saw them, and the payer — so the order to release is `payment.requirements.extra.memo`, with no need to decode the header again.

It is present **exactly when an undo may be owed**: once `preSettle` has accepted, and not before. So a refusal that never got that far — a header that would not decode, a payment refused on price or on verify, or `preSettle`'s own refusal — carries `reason` and `details` but no `payment`. (A request carrying no payment at all is the plain challenge rather than a rejection, and does not reach `onReject`.) That is deliberate: before verify the requirements are whatever the header claimed, so an underpriced payment echoing one of your references would otherwise name it here, and releasing it would release an order someone else is paying for.

One case it cannot settle for you: a **502 from a settle that threw** may mean the payment went through and the answer was lost, rather than that it did not happen. Undoing there is a choice about which way to be wrong — reconcile against the ledger if that matters to you.

It is not memo-specific — it is where any check needing your own records belongs. With `settle: false` it is simply the last gate before the request is let through.

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
