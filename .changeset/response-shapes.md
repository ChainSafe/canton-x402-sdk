---
"@chainsafe/x402-core": major
"@chainsafe/x402-express": major
---

**Breaking.** Core's verify, settle and supported answers have the fields x402
v2 gives them, under its names, required where it requires them. A buyer
decodes the settle answer exactly as the facilitator sent it, from
`PAYMENT-RESPONSE`, so these types are what a client written against the spec
reads. After 1.0.0, renaming a field or making one required waits for 2.0.

- **A failed settle** always carries `transaction` and `network` (§5.3.2).
  `transaction` is `""` when nothing was relayed, and on `settlement_pending` it
  is the relayed transfer.
- **`errorDetails` is gone.** Free text goes in `errorMessage`, which a client
  must not match on (§9). Which of a code's causes it was goes in
  `extensions.detail`, as it does on verify, and a failed settle can now carry
  `extensions`.
- **A successful settle** may leave out `payer`, has no top-level
  `completionOffset`, and may carry `amount`: the amount settled, in atomic
  units.
- **`isSettlementPending`** needs a non-empty `network` as well as a non-empty
  `transaction`, as §9 asks of a pending answer. One without it is read as a
  plain failure. Its predicate type is now
  `response is SettleResponseError & { errorReason: "settlement_pending" }`.
  With `transaction` required, the old `& { transaction: string }` added
  nothing, and narrowed the other branch to `never`.
- **Verify answers** may carry `extra`, and an invalid one may carry
  `invalidMessage` (§5.4.2).
- **`SupportedResponse`** requires `extensions`, a list of extension ids, and
  `signers`, lists of signers keyed by network pattern such as `canton:*`
  (§7.3.1). A hand-built `{ kinds }` passed to `selectDeployments` or
  `selectCantonDeployments` no longer type-checks.
- **`decodePaymentResponseHeader`** requires `transaction` and `network` on a
  failure too, and refuses an `errorMessage` or `amount` that is not a string
  and an `extensions` that is not an object. A reason or a field it does not
  know still passes.

**For a merchant on `@chainsafe/x402-express`,** the `details` of a failed
settle's 402, and the `details` `onReject` receives, now come from
`extensions.detail`, or from `errorMessage` when the answer names no cause.
They used to come from `errorDetails`, which a facilitator still writing it now
leaves unread. A pending 402's body names the `network` beside the
`transaction`.

### What a facilitator changes

| was | now |
| --- | --- |
| `errorDetails` holding a cause code | `extensions.detail` |
| `errorDetails` holding free text | `errorMessage` |
| a failure with no `transaction` or `network` | `transaction: ""` (or the hash), plus `network` |
| `completionOffset` | dropped, or put in `extensions` |
| `extensions.settledAmount` (a decimal) | `amount` (atomic units) |
| `/supported` answering `{ kinds }` | `{ kinds, extensions, signers }` |
