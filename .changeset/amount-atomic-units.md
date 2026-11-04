---
"@chainsafe/x402-core": major
"@chainsafe/x402-express": major
"@chainsafe/x402-server-sdk": major
---

**Breaking.** `PaymentRequirements.amount` is an integer string of atomic units,
and the verifier requires the transfer to pay **exactly** that.

```diff
- "amount": "0.05",
+ "amount": "500000000",
```

The spec: *"Integer string of atomic units (1 CC = 1e10 units)."* One atomic unit
is 1e-10 of a token for every Canton instrument, not for Canton Coin
specifically — Daml's `Decimal` is `Numeric 10`, a fixed ten decimal places.

**Exact, not a floor.** Rule 4 says the transfer amount MUST equal the quote;
`amountGte` allowed an overpayment and said so in its docstring. `exact` is the
scheme's distinguishing property, and a payer who signs for more than was quoted
loses the difference with no refund path.

**The merchant keeps pricing in whole tokens.** A route still declares
`amount: "0.05"` meaning 0.05 CC; the middleware converts. Getting these two the
wrong way round misprices by 1e10, so the option is documented as whole tokens
and the conversion has its own test.

New in `@chainsafe/x402-core`:

| | |
| --- | --- |
| `isValidAmount` | now the **atomic** form — an integer string. It previously accepted decimals. |
| `isValidLedgerAmount` | the on-ledger `Decimal`, ≤10 places — what `isValidAmount` used to be |
| `ledgerToAtomic` / `atomicToLedger` | conversion, `null` on malformed input rather than a coerced zero |
| `amountMatches` | replaces `amountGte`; equality across the unit boundary |

`requirementsHash` changes again, because `amount`'s value does.
