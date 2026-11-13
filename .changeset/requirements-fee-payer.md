---
"@chainsafe/x402-core": minor
"@chainsafe/x402-express": minor
---

`extra.feePayer`, the facilitator's own party, which the Canton scheme spec
lists and we did not send.

```diff
  "extra": {
    "assetTransferMethod": "transfer-factory",
    "synchronizerId": "global-domain::1220be58c29e",
+   "feePayer": "x402-facilitator::1220…",
    "instrumentId": { "id": "Amulet", "admin": "DSO::1220…" },
    "executeBeforeSeconds": 120
  }
```

Scope 5 of #76, the SDK half of ChainSafe/canton-x402-facilitator#339. It is
the relayer that submits the payer-signed transfer and pays its traffic fee.
Rule 9 has the facilitator refuse any party but its own, and clients MUST NOT
alter it.

**Core.** `feePayer` is an optional key in `CantonSupportedExtraSchema`,
`CantonDeploymentExtra` and `CantonRequirementsExtraSchema`. It is optional
because the requirements schema is also how a facilitator reads what merchants
send, and requiring it would refuse every merchant on an older SDK. Core's
verifier does not check Rule 9: nothing the payer signs carries the party, and
only the facilitator knows which one it is. It does now refuse a malformed one
(empty, `null` or not a string) as `invalid_payment_requirements`, as it does a
malformed `memo`, so a facilitator on this core answers that before its own
Rule 9 check.

**Express.** The middleware quotes the `feePayer` the facilitator advertises in
`kinds[].extra` on `GET /v2/supported`, and quotes none when it advertises none.
A new optional `feePayer` on the requirements spec is quoted only where nothing
is advertised: `network` pinned alongside a whole `asset`, which reads nothing,
or a facilitator that does not advertise one. The advertised party always wins
over it, since any other is refused. An empty one is a `TermsError` either way.

On the paid retry an echoed `feePayer` is held to the quote like the
synchronizer is, so an altered, stripped or added one answers
**`policy_fee_payer`** before the facilitator is called. A payer built on this
SDK echoes `accepted` whole and is unaffected.
