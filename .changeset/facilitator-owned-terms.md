---
"@chainsafe/x402-express": major
---

**Breaking. What the facilitator owns can no longer be configured.**

The instrument's registry admin, the synchronizer a deployment submits to and
the party that relays the transfer (`feePayer`) are the facilitator's own facts.
A merchant value that differed from them failed only at verify, after the payer
had signed. They are now always read from `GET /v2/supported`.

- `CantonRequirementsSpec` loses `synchronizerId` and `feePayer`.
- `asset` takes only an instrument id (`"Amulet"`, `"USDCx"`). The
  `{ instrumentId: { id, admin } }` form is gone; the admin comes from
  `/v2/supported`.
- Naming `network` no longer skips discovery. It chooses which of the
  facilitator's deployments to quote, and `/v2/supported` is read either way
  (cached by `FacilitatorClient`, so one round trip per TTL).
- A facilitator that advertises no `feePayer` cannot be quoted against. That
  way to pay is dropped and reported, as a facilitator fault, not a merchant
  `TermsError`.
- A **builder**'s requirements are held against `/v2/supported` before the 402
  is issued: an `extra.instrumentId`, `extra.synchronizerId` or `extra.feePayer`
  that differs from what the facilitator advertises is refused as a
  `TermsError`. A scheme adapter can do the same for its own fields through the
  new optional `SchemeAdapter.checkBuilt`.
- `TermsError` is exported, so an adapter can say a failure is the merchant's
  configuration (failing the request) rather than the facilitator's answer
  (dropping that way to pay).

To migrate, delete `synchronizerId` and `feePayer` from your requirements, and
write `asset: "Amulet"` (or the instrument's id) in place of an `instrumentId`
object.
