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

The spec states the factor only for Canton Coin — *"Integer string of atomic
units (1 CC = 1e10 units)"* — but it is the wire's, not CC's. The reference
facilitator states it for every instrument: *"Every instrument uses 10 decimals
on the wire (1 token = 10^10 atomic units)"* ([FTP][ftp], `docs/deployment.md`),
and its token config carries an id and a symbol with no decimals field.

This is worth stating because the obvious assumption is wrong: USDC is six
decimals on EVM and ten here. The unit follows the Daml `Decimal`
representation, not the token's native denomination.

[ftp]: https://github.com/FTP-Tech-LLC/x402-canton-facilitator

**Exact, not a floor.** Rule 4 says the transfer amount MUST equal the quote;
`amountGte` allowed an overpayment and said so in its docstring. `exact` is the
scheme's distinguishing property, and a payer who signs for more than was quoted
loses the difference with no refund path.

`amountGte` is removed with no replacement export. The comparison lives inline
in `findTransferMismatch`, where both sides can be named for what they are — a
two-string helper spanning two units reads the same whichever way round it is
called.

**One unit everywhere, including the merchant's own options.** A route now
declares `amount: "500000000"` rather than `"0.05"`, and the middleware does not
convert.

The alternative — keeping merchants in CC and converting — was rejected because
`paymentRequired` takes either a declarative spec or a
`(req) => CantonPaymentRequirements` builder under the **same** key, and both
type `amount` as a string. A merchant moving from one to the other would carry
`"0.05"` across and silently underquote by 1e10. With one unit there is nothing
to carry wrong, and a decimal is now refused rather than misread.

New in `@chainsafe/x402-core`:

| | |
| --- | --- |
| `isValidAmount` | now the **atomic** form — an integer string. It previously accepted decimals. |
| `isValidLedgerAmount` | the on-ledger `Decimal`, ≤10 places — what `isValidAmount` used to be |
| `ledgerToAtomic` / `atomicToLedger` | conversion. Both take `decimals` explicitly — no default, so a call site states the scale it converts at. `null` on malformed input rather than a coerced zero, and `ledgerToAtomic` also refuses more precision than the scale holds. |
| `WIRE_DECIMALS` | the scale itself, `10` |

Removed: `amountGte`.

`requirementsHash` changes again, because `amount`'s value does.
