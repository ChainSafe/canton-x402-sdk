---
"@chainsafe/x402-core": major
"@chainsafe/x402-express": major
---

**Breaking.** `PaymentRequirements` carries the two fields the spec requires of
every 402 and we left out: a `maxTimeoutSeconds` at the top level and
`extra.assetTransferMethod`.

```diff
  "payTo": "merchant::1220…",
+ "maxTimeoutSeconds": 60,
  "extra": {
+   "assetTransferMethod": "transfer-factory",
    "instrumentId": { "id": "Amulet", "admin": "DSO::1220…" }
  }
```

`maxTimeoutSeconds` is how long the client has to complete payment. The base
spec lists it Required for every scheme; ours was `v.optional(v.number())` and
nothing ever set it. It is now required and read as a duration rather than as
any number — `v.number()` already refuses `NaN` but admits `Infinity`, `0`,
negatives and fractions, and none of those is a time a client can be given.

`extra.assetTransferMethod` is a reserved protocol key, which the spec says to
interpret as defined rather than as opaque scheme data, so a value other than
`"transfer-factory"` is refused instead of passed through. Canton's `exact`
defines exactly one, exported as `ASSET_TRANSFER_METHOD`.

Both are also on the requirements *envelope*. Leaving the envelope alone would
have made the narrowing guard the stricter of the two, which is the inversion
the previous release fixed for the string fields.

The express middleware fills both in, so a merchant that states neither keeps
working. `maxTimeoutSeconds` is a new option, per request like the others, and
defaults to 60 — the value both specs use in their examples. It stays separate
from `validForSeconds`, which says how long the quote remains settleable.

The golden canonicalization vector moves, since the hash covers every value.
Regenerated from the facilitator's own canonicalizer and checked against it:
`maxTimeoutSeconds` is the first number in that fixture, so it now pins number
formatting across the two implementations as well.
