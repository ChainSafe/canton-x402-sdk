---
"@chainsafe/x402-express": patch
---

Internal restructuring of the middleware, with no change in behaviour or in the
public API.

- The request handler reads as named steps: read the payment, hold it to the
  terms, verify, `preSettle`, settle.
- Each module has one job: `policy.ts` holds everything about comparing a
  payment to the terms (the rule tables and `compareQuote`), `scheme.ts` only
  the adapter contract, `options.ts` only types, and `quotes.ts` building quotes
  and checking the merchant's terms.
- Every export keeps its name; only the module it is defined in moved.
