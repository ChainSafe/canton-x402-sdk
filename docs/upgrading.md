---
description: Migrate an Express merchant off facilitator-owned configuration.
---

# Upgrading

`@chainsafe/x402-express` no longer accepts configuration whose source of truth
is the facilitator. The instrument registry admin, the synchronizer, and the
relaying `feePayer` are read from `GET /v2/supported` on every quote. Discovery
is cached by `FacilitatorClient` (`supportedTtlMs`, default 5 minutes).

## Delete these from a requirements spec

| Before | After |
| --- | --- |
| `synchronizerId` | Remove it. The quote uses `extra.synchronizerId` from `/v2/supported`. |
| `feePayer` | Remove it. The quote uses the advertised party. There is no merchant fallback. |
| `asset: { instrumentId: { id, admin } }` | `asset: "Amulet"` or `asset: "USDCx"`. The admin comes from `/v2/supported`. |
| `network` used to skip discovery | `network` only chooses which advertised deployment to quote. Discovery still runs. |

`payTo`, `amount`, `resource`, `description`, `maxTimeoutSeconds`,
`executeBeforeSeconds`, and `memo` stay merchant-owned.

## What fails closed

- A deployment that advertises no `feePayer` cannot be quoted. That way to pay
  is dropped and reported through `onQuoteError`. It is a facilitator fault,
  not a `TermsError`. Other ways to pay on the same route still quote.
- If the named instrument is settled on more than one network, `network` is
  required. The middleware does not guess.
- A builder writes the whole of `extra`, so its `instrumentId`,
  `synchronizerId`, and `feePayer` are compared with `/v2/supported` before the
  402 is issued. A mismatch is a `TermsError`.

A requirements object with no `feePayer` still fails to parse as canton-exact
on the wire. The merchant no longer supplies that field. The middleware copies
the one the facilitator advertised.
