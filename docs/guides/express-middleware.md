---
description: Gate Express routes with paymentRequired() — what it does on each request, every option, pricing several ways to pay, memos and preSettle, and gating on another scheme.
---

# Express middleware

`paymentRequired()` from `@chainsafe/x402-express` gates a route. It answers
`402 Payment Required` with the terms when a request is unpaid, verifies a
payment against the facilitator (and settles it, with `settle: true`), and lets
a paid request through with the verified payer on `req.x402`.
[Accept payments](/get-started/accept-payments) is the five-minute version;
this page is the rest.

```bash
npm install @chainsafe/x402-express @chainsafe/x402-client express
```

The package ships ESM and CommonJS, so
`const { paymentRequired } = require("@chainsafe/x402-express")` works too.

## A gated route

```ts
import express from "express";
import { FacilitatorClient } from "@chainsafe/x402-client";
import { paymentRequired } from "@chainsafe/x402-express";

const app = express();

// One client, shared by every paymentRequired() mount.
const facilitator = new FacilitatorClient(process.env.FACILITATOR_URL!, {
  apiKey: process.env.FACILITATOR_API_KEY!,
});

app.use(
  "/paid",
  paymentRequired({
    facilitator,
    settle: true, // capture the payment after a valid verify (default: false)
    requirements: {
      payTo: "merchant::1220…",
      accepts: [{ amount: "500000000", asset: "Amulet" }], // 0.05 CC
    },
  }),
);

app.get("/paid", (req, res) => {
  // Reached only on a verified payment.
  res.json({ message: "Thanks!", payer: req.x402!.payer });
});
```

`FACILITATOR_URL` is one of the facilitators on [Networks](/get-started/networks).

## What happens on each request

1. **Unpaid** (no payment, or an invalid one): a `402` with the spec's
   `PaymentRequired`, `{ x402Version: 2, resource, accepts: [...] }`,
   base64-encoded in the `PAYMENT-REQUIRED` header and as the body. There is one
   `accepts[]` entry per way to pay, with the defaults filled in. A `memo`
   generator is called here, and only here.
2. **Paid**: the `PAYMENT-SIGNATURE` header is decoded. The payment carries the
   requirements it was built against as `accepted`; the middleware works out
   which of its own quotes that is, holds the payment against it, and sends it
   to the facilitator's `/v2/verify`. `X-PAYMENT`, the header name before the
   spec's, is still read when `PAYMENT-SIGNATURE` is absent.
3. **Verified** (and settled, with `settle: true`): the payer goes on
   `req.x402`, `next()` is called, and the facilitator's settle answer goes back
   in the `PAYMENT-RESPONSE` header, base64 JSON (read it with
   `decodePaymentResponseHeader` from `@chainsafe/x402-core`).

A refused payment gets a `402` with a **fresh** challenge, never the terms the
payer just failed on, so a retrying client is handed terms it can pay. A failed
settle sends its answer in `PAYMENT-RESPONSE` beside that challenge. A
`settlement_pending` answer is different: see
[Pending payments](/guides/pending-payments).

### What is checked before the facilitator

The requirements a payment echoes are not signed, so before anything reaches the
facilitator they are held against your own terms: `scheme`, `network`, `payTo`,
the instrument (not just its symbol), the quoted `executeBeforeSeconds`,
`maxTimeoutSeconds`, and an amount that is not under your price. Verification
then uses those echoed requirements, because they are what the payer signed a
transfer against.

`description` is deliberately not compared, since it never reaches the ledger.
Nor is `memo`: the middleware keeps no record of what it issued, so only your
[`preSettle`](#memo-and-presettle) can judge it.

A header that is not a spec payment (the pre-spec `{ payment, requirements }`
shape, or a payment without a whole `accepted`) is refused before anything reads
it, and costs no verify.

### CORS

A browser page on another origin can read `PAYMENT-REQUIRED` and
`PAYMENT-RESPONSE` only if your CORS setup lists them in
`Access-Control-Expose-Headers`, and can send `PAYMENT-SIGNATURE` only if the
preflight allows it in `Access-Control-Allow-Headers`.

## Options

| Option         | What it does                                                                                                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `facilitator`  | The `FacilitatorClient` that verifies and settles.                                                                                                                                                                                                          |
| `requirements` | The terms: a spec or a builder. See [below](#requirements).                                                                                                                                                                                                 |
| `settle`       | Settle via `/v2/settle` after a valid verify. Default `false`: verify only.                                                                                                                                                                                 |
| `preSettle`    | `(payment, req) => string \| undefined`. Your own check on a verified payment, before anything settles. Return a short reason to refuse it. See [below](#memo-and-presettle).                                                                               |
| `onReject`     | `(rejection, req) => void`. Called when a payment is refused (`402`) or the facilitator or middleware fails (`502`/`500`), with `{ status, reason, details?, extensions?, error?, payment? }`. The middleware logs nothing itself, so this is where to log. |
| `onQuoteError` | `(error, req) => void`. Called when a way to pay could not be quoted and was left out of the `402`, for example because the facilitator stopped settling its instrument. Without it, a way to pay can disappear unnoticed.                                  |
| `scheme`       | The scheme to gate on. Default: Canton `exact`. See [Another scheme](#another-scheme).                                                                                                                                                                      |

## Requirements

A `402` advertises **one resource and a list of ways to pay for it**, as x402 v2
§5.1.2 defines it, and the configuration has the same shape:

```ts
requirements: {
  // the sale, named once
  payTo: "merchant::1220…",
  resource: "https://merchant.example/report", // default: the request URL
  description: "Quarterly report",

  // the ways to pay, each advertised as one accepts[] entry
  accepts: [
    { amount: "500000000", asset: "Amulet" }, // 0.05 CC
    { amount: "250000", asset: "USDCx" }, // priced separately
  ],
}
```

- **`payTo`, and each entry's `amount` and `asset`, are required.** `amount` is
  atomic units of the instrument (10 decimals for Canton Coin, so 0.05 CC is
  `"500000000"`). Each entry carries its own price: nothing here checks that two
  entries are worth the same.
- **`asset` is an instrument id**: `"Amulet"` for Canton Coin (the one id that
  differs from its symbol, `"CC"`), or `"USDCx"`.
- **Any shared field can be overridden per entry**, except `resource` and
  `description`, which name the sale rather than a way to pay for it.
- **Defaults:** `maxTimeoutSeconds` 60, `extra.executeBeforeSeconds` 120, and
  `extra.assetTransferMethod`.
- **Any field can be a function** `(req) => value`, resolved per request.

**What the facilitator owns, you cannot configure.** The instrument's registry
admin, the synchronizer and the `feePayer` that relays the transfer are read from
the facilitator's `GET /v2/supported`. A wrong one would only surface at verify,
after the payer had signed, so there is no field for them.

**`network` is optional.** Named (`canton:mainnet`, say), it picks which of the
facilitator's deployments to quote; left out, it is discovered from the
instrument the entry names. `/v2/supported` is cached by `FacilitatorClient`
(`supportedTtlMs`, 5 minutes by default). If more than one network settles the
instrument, or the facilitator does not carry it, that is an error rather than a
guess.

### A builder

For full control, `requirements` can be a builder,
`(req) => CantonPaymentRequirements[]`, which returns the whole list. You then
own `maxTimeoutSeconds` and the rest of `extra`. The facilitator's fields in
`extra` (`instrumentId`, `synchronizerId`, `feePayer`) are still held against
`/v2/supported` before the `402` goes out, and one that differs is refused.

A builder runs on every request, paid ones included, because a payment has to be
held against your terms and only the builder knows them. Keep it free of side
effects, and use `memo` for anything that should happen once per challenge.

## Memo and preSettle

`memo` is a **function only**, `(req) => string | Promise<string>`, called once
per challenge **issued**: on the `402` that offers terms, not on the request
that pays them. So it can generate and record an order reference without a
successful payment booking a second one. Quoting a memo binds it: the payer must
sign the identical value into the transfer.

**Write it once, in the shared terms**, if it books anything. Entries carrying
the same function are issued one reference between them; the same body written
out in two entries is two functions, two references, and two orders booked, only
one of which is ever paid.

```ts
requirements: {
  payTo: "merchant::1220…",
  memo: (req) => orders.open(req), // once, for the sale
  accepts: [
    { amount: "500000000", asset: "Amulet" },
    { amount: "250000", asset: "USDCx" },
  ],
}
```

**A memo proves less than it looks.** The transfer is compared with the
requirements the **payer** echoed, so a payer can echo no memo and sign none, or
echo any value and sign that, and nothing in the SDK makes a memo single-use. If
you reconcile on it, check it in `preSettle`, which runs **after verify and
before any settle**:

```ts
preSettle: async ({ requirements, payer }) => {
  const order = await orders.findByRef(requirements.extra.memo);
  if (!order) return "policy_memo_unknown";
  if (order.status !== "awaiting-payment") return "policy_order_closed";
  if (!(await allowed(payer))) return "policy_payer_blocked";
},
```

After verify, `requirements` has been held against the signed transfer, so a memo
there is one the payer committed to, and `payer` is the transfer's verified
sender. It is the place for any check that needs your own records; with
`settle: false` it is the last gate before the request is served.

### Undoing it

Settle can still fail after `preSettle` reserved something. `onReject` then
receives `payment` (the payload, the requirements as `preSettle` saw them, and
the payer), so the order to release is `payment.requirements.extra.memo`.

`payment` is present **exactly when an undo may be owed**: once `preSettle` has
accepted. A refusal that never got that far carries no `payment`, so an
underpriced payment echoing one of your references cannot make you release an
order someone else is paying for.

One case it cannot decide for you: a `502` from a settle that threw may mean the
payment went through and the answer was lost. Reconcile against the ledger if
that matters to you.

## `req.x402`

On a paid request:

```ts
req.x402 = {
  payer: string; // the signed transfer's sender
  requirements: CantonPaymentRequirements;
  payload: CantonPaymentPayload;
  verify: VerifyResponse;
  settle?: SettleResponse; // with settle: true
};
```

## Another scheme

Canton `exact` is the default and needs no wiring, but nothing in the middleware
is Canton-specific. It owns the HTTP flow and the fields x402 v2 gives every
scheme (`scheme`, `network`, `payTo`, `asset`, `amount`, `maxTimeoutSeconds`). A
**scheme adapter** owns `extra`:

```ts
interface SchemeAdapter<TSpec, TRequirements, TPayload> {
  id: string;
  // The only checks on a header someone else sent.
  acceptsRequirements(r: X402PaymentRequirements<unknown>): r is TRequirements;
  acceptsPayload(p: X402PaymentPayload<unknown>): p is TPayload;
  // Who paid, when the facilitator does not say.
  payerOf(payload: TPayload): string | undefined;
  // How each field of `extra` is held against the merchant's.
  extraRules: RuleTable;
  // The scheme's part of a quote, including its per-challenge reference.
  quote(req, spec: TSpec, ctx): Promise<SchemeQuote>;
  distinctKey?(spec: TSpec): string | undefined;
  unreadablePayerReason?: string;
  checkBuilt?(requirements: TRequirements, ctx): Promise<void>;
}
```

- **Configuration errors:** an adapter throws a `TermsError` (exported from this
  package) from `quote()` or `checkBuilt()` when the merchant's configuration is
  wrong; it fails the request. Any other error is read as the facilitator's
  answer changing: that way to pay is dropped from the `402` and reported
  through `onQuoteError`.
- **References:** `quote()` can return a `mintReference()`, called only when a
  challenge is issued, the same discipline `memo` gets. Quotes sharing a
  `referenceKey` are issued one reference between them.

```ts
app.use(
  "/paid",
  paymentRequired<VoucherSpec, VoucherRequirements, VoucherPayload>({
    facilitator,
    scheme: voucherScheme,
    requirements: { payTo: "shop::1", accepts: [{ amount: "10", book: "autumn-2026" }] },
  }),
);
```

`req.x402` is typed for the default scheme; `X402RequestState<TRequirements,
TPayload>` is exported for a route gated on another.
