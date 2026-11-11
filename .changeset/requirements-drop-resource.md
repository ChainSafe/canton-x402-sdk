---
"@chainsafe/x402-core": major
"@chainsafe/x402-express": major
"@chainsafe/x402-server-sdk": major
---

**Breaking.** `PaymentRequirements` drops `resource` and `description`, the last
two fields it carried that the spec does not define (#76, item 7).

```diff
  "payTo": "merchant::1220…",
- "resource": "https://api.example.com/paid",
- "description": "Access to /paid",
  "maxTimeoutSeconds": 60,
```

x402 v2 names the resource once, in `PaymentRequired`, and lets a payment echo
it in `PaymentPayload.resource`. It is not a property of one way to pay, and
repeating it per `accepts[]` entry invites entries that disagree about what is
being sold. Every registered Canton facilitator already omits both: the live
`accepts[]` entries from `facilitator.ftptech.xyz`'s merchants carry `scheme`,
`network`, `amount`, `asset`, `payTo`, `maxTimeoutSeconds` and `extra`, and
nothing else.

Both landed in `PaymentRequired` with #109, so nothing is lost on the wire —
this removes the second copy.

**Middleware.** `resource` and `description` stay where a merchant writes them,
on the terms, and are resolved once into the 402's top-level `resource`.
`buildQuotes` returns `{ resource, quotes }` rather than a bare list, which is
the spec's own shape.

A builder can no longer name the resource by putting it on a requirement, so it
gains a slot:

```diff
- requirements: (req) => [requirements]
+ requirements: (req) => ({ resource: "https://merchant.example/report", accepts: [requirements] })
```

A builder returning a bare array still works and leaves the resource implicit —
the request URL, as before.

**The resource check moved, and is weaker than it read.** `policy.ts` compared
the echoed `requirements.resource` against the merchant's, under a comment
saying it stopped a payment minted for path A being replayed against path B.
It did not. The echoed requirements are payer-supplied and unsigned, and the
signed transfer encodes the amount, payee, instrument, deadline and memo —
never the resource — so a payer replaying a payment need only write path B's
URL into what it echoes. The rule caught a client that re-sent path A's
requirements verbatim, which is a bug, not an attack.

The check now reads `PaymentPayload.resource`, the spec's own slot and the only
resource a payer sends. It is optional, so a payment naming none is accepted
and one naming another resource is `policy_resource`. The strength is unchanged
— echo fidelity — and a test now records that limit rather than overstating it.
What actually ties a payment to one challenge is `extra.memo`: Rule 12 puts it
inside the signature, and only the merchant's own records can say whether it is
one they issued, which is what `preSettle` is for.

**The payer echoes it, and now reads the 402 the way the transport defines.**
`X402Payer.authorize` takes a second argument, `PaymentContext`, carrying the
`resource` the 402 named; `CantonX402Payer` puts it on `PaymentPayload.resource`
and omits the field when given none. A payer implementation that ignores the
argument still satisfies the interface.

Supplying it meant reading the 402's envelope, which exposed a separate bug:
`createX402Fetch` read `accepts[]` from the response **body**. The HTTP
transport makes `PAYMENT-REQUIRED` the canonical location and calls the body a
server implementation concern — and every registered Canton merchant answers
with a 2-byte `{}` body. `api.cctools.network`, `x402.meridiant.xyz` and
`api.appsfactory.cc` all do. So this wrapper silently declined to pay all of
them, returning the 402 untouched. It now reads the header first and falls back
to the body, which this SDK's own middleware sends as well.

New in `@chainsafe/x402-core`: `decodePaymentRequiredHeader`, the counterpart of
`encodePaymentRequiredHeader`, with the same depth cap and envelope checks the
payment decoder has — and, like it, scheme-agnostic. It validates the envelope
(x402 v2, a `resource` with a `url`, an `accepts[]` of entries carrying the
fields every scheme's requirements share) and leaves per-scheme judgement to
the payer, which asks it per entry through `supports()`. Reading each entry as
canton-exact would throw a mixed-scheme 402 out over an entry the reader was
never going to pay, leaving it nothing to pay with.

`isX402PaymentRequiredResponse` and `X402PaymentRequiredResponseEnvelopeSchema`
are exported for that check; `isCantonPaymentRequiredResponse` stays for a
caller that does want the strict canton-exact read.

### What actually binds a payment to a resource

Comparing what the payer echoes proves a client is consistent, not that the
payment was minted for this route: nothing the payer sends is signed. The
binding is a stamp INSIDE the prepared transaction, under
`meta["x402.resourceUrl"]`, which the payer signs with the rest of the transfer
— so a transfer for one resource cannot unlock another.

It is the SHA-256 of the URL, not the URL. Canton's ledger is readable, and
plaintext would publish which API an agent buys from to every stakeholder and
to Scan. An upstream convention rather than a field of the registered scheme
spec, which names only `x402.memo`; the registered facilitator stamps and
checks it, and tolerates its absence.

- `CantonX402Payer` stamps it, from the resource the 402 named.
- The middleware checks a stamp that is present, accepting the hash and the
  plaintext (clients deployed before the hashed form stamp the URL itself).
- An absent stamp is a payment carrying no binding. Tolerated by default, since
  payers predating the convention do not stamp; `requireResourceStamp: true`
  refuses them. Turn it on where two routes share a price, payee and
  instrument, because then nothing else tells a payment for one from a payment
  for the other. A scheme that reads no stamp cannot satisfy the flag, so
  setting it there throws when the route is mounted rather than refusing every
  payment.

**Pin `resource` where the binding matters.** Left out, it is the request's own
URL, and that URL's host is the client's `Host` header — so the path binds and
the host does not, and two hosts serving one path are not told apart. A fixed
`resource` is not a header anyone can set.

New in `@chainsafe/x402-core`: `hashResourceUrl` and `resourceUrlMatchesStamp`,
and `DecodedTransfer.resourceUrlStamp`. Schemes expose their own through
`SchemeAdapter.resourceStampOf`.

The payload's transfer is now decoded once per payment and shared between
reading the payer and reading the stamp, rather than once per question.

**`requirementsHash` changes for every payment**, because the canonical form
lost two fields. The golden vector is regenerated and checked against the
facilitator's own RFC 8785 canonicalizer, which produces the same bytes:

```
{"amount":"100000000","asset":"CC","extra":{…},"maxTimeoutSeconds":60,
 "network":"canton:devnet","payTo":"merchant::1220dead","scheme":"exact"}
7ce2010798b65d3c3082b29a8e1071a96191457a844cac4330aa662f4ca9fb54
```

The facilitator reads the hash from `@chainsafe/x402-core` rather than
canonicalizing its own requirements, so it follows by upgrading — but any
vector pinned on its side moves with this release.

`CantonPaymentObjectRequest` and `CantonPaymentObjectResponse` keep their
`resource`: `/payment-object` is a different endpoint with its own schema, and
nothing in #76 touches it.
