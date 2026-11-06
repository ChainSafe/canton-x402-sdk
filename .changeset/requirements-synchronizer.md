---
"@chainsafe/x402-core": major
"@chainsafe/x402-express": major
"@chainsafe/x402-server-sdk": major
---

**Breaking.** `extra.synchronizerId` — the Global Synchronizer the transfer
settles on — and the check that pins a payment to it.

```diff
  "extra": {
    "assetTransferMethod": "transfer-factory",
+   "synchronizerId": "global-domain::1220xyz…",
    "instrumentId": { "id": "Amulet", "admin": "DSO::1220…" },
    "executeBeforeSeconds": 120
  }
```

The network id stopped carrying this when it became a name, so there was
nowhere left for it to travel. The payer now prepares against the quoted
synchronizer, and the verifier pins the transaction's signed
`Metadata.synchronizer_id` to it — in the signed block, so it is the payer's
commitment rather than a relay's choice. A mismatch is `transfer_mismatch` with
detail `synchronizer`. The spec defines no rule for this; the check is ours,
because without it a payment lands on whatever domain the transfer names,
which need not be one the merchant settles on.

**Logical in, physical out.** `prepare` takes the LOGICAL id
(`global-domain::1220<fingerprint>`) and rejects the physical one, yet the
bytes it returns carry the physical form — the logical id plus a
participant-chosen `::<protocol-version>-<topology-serial>`. So the merchant
quotes the logical id and the pin accepts either it exactly, or it followed by
a strict `::<n>-<m>`. That is not a weakening: the `1220…` is the domain's
namespace fingerprint, so `<quoted>::<n>-<m>` is provably the same domain at a
different version and serial. Anything else — another name, another
fingerprint, a non-numeric or three-part suffix, trailing text — is refused.

An exact-equality pin would have refused every honest payment.

**Middleware.** `synchronizerId` is a new **required** option with no default:
it is deployment state, and a default would quote a domain the merchant may not
settle on. Read it from the facilitator's `/supported`.

`DEVNET_SYNCHRONIZER_ID` and `MAINNET_SYNCHRONIZER_ID` were already exported,
so the mortgage example defaults from the chosen network the way `DSO_PARTY`
does, and takes `SYNCHRONIZER_ID` from the environment for localnet.

The golden canonicalization vector moves again, regenerated from the
facilitator's own canonicalizer and checked against it.
