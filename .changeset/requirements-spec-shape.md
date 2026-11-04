---
"@chainsafe/x402-core": minor
"@chainsafe/x402-express": minor
"@chainsafe/x402-server-sdk": minor
---

**Breaking.** PaymentRequirements takes the shape the registered Canton scheme
spec defines: `amount` instead of `maxAmountRequired`, and `asset` as a symbol
with the instrument moved to `extra.instrumentId`.

```diff
- "maxAmountRequired": "0.05",
- "asset": { "instrumentId": { "id": "Amulet", "admin": "DSO::1220…" } },
+ "amount": "0.05",
+ "asset": "CC",
+ "extra": { "instrumentId": { "id": "Amulet", "admin": "DSO::1220…" } },
```

`asset` is a symbol because that is what the spec carries — `"CC"` for Canton
Coin, or a registry token's own. A symbol cannot say which registry issued the
instrument, so `extra.instrumentId` is required and is what the verifier binds
the transfer against. `assetSymbol()` maps an instrument to its symbol; the one
case where the two differ is Canton Coin, whose instrument is `Amulet`.

No compatibility shim: the old spelling is not accepted. Clients and
facilitators move together.

**The middleware's own options are unchanged.** A merchant still declares
`asset: { instrumentId: { id, admin } }`; the symbol is derived and the
instrument placed in `extra` when the 402 is built.

**`requirementsHash` changes for every payment**, because the canonical form
did. Any golden vector pinned against it must be regenerated on both sides of
the wire in the same release.

Not included, and still divergent from the spec: `resource` and `description`
(which the spec puts on PaymentPayload), and `nonce` and `validBefore` (which
it does not define at all).
