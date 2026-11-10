---
"@chainsafe/x402-core": minor
---

Read a facilitator's `/v2/supported` as configuration.

`kinds[].extra` is Optional and scheme-defined in x402 v2 §7.3, and a canton
deployment puts in there what it settles: the synchronizer it submits to, the
instruments it validates — each with the registry party that admins it — and the
transfer methods it speaks. Those are the facts a merchant needs in order to
quote, and reading them from the facilitator means reading them from the service
that will accept or refuse the payment, rather than from a constant someone
copied into a deployment and has to keep true.

```ts
selectCantonDeployments(await facilitator.supported());
// [{ scheme, network, asset: "CC", extra: { instrumentId: { id, admin }, synchronizerId } }]
```

### Plural, because `accepts[]` is

A 402 advertises a LIST of ways to pay, so these return lists and the preference
takes lists — a merchant accepting two instruments is making a choice, not
failing to make one:

```ts
selectCantonDeployments(supported, { networks: ["canton:devnet"], instruments: ["Amulet"] });
```

One entry per instrument per kind, in the order the facilitator advertised them,
so a merchant's `accepts[]` is predictable.

There is no singular form. Core reports what is on offer; whether offering
several is an error is the merchant layer's call, and that layer is also the only
one that can say how to fix it, because it knows the quote is configured as
`network:`/`instrument:` on a requirements spec — not as these parameters.

Plural is the right primitive on its own terms too: "exactly one, else refuse" is
three lines on top of a list, while a list cannot be recovered from a function
that throws on several. The refusing form is the lossy one.

Each entry still needs its own price — a merchant advertising two instruments is
quoting two amounts, and 0.05 of one token is not 0.05 of another — so these
return terms, not quotes. The pairing stays the merchant's.

### Split the way the wire types are

Picking WHICH kinds match is the protocol's business; reading `kinds[].extra` is
the scheme's, because `extra` is scheme-defined and no two schemes spell it the
same way. So the generic half takes the scheme's reader as an argument:

```ts
selectDeployments<TExtra>(
  supported: SupportedResponse,
  selectExtra: DeploymentExtraSelector<TExtra>,
  prefer?: DeploymentPreference,
): Array<DeploymentTerms<TExtra>>
```

`DeploymentTerms<TExtra>` carries `scheme`, `network` and `asset` — every
scheme's, since the spec types `asset` as a string whatever the scheme — with the
rest under `extra`, mirroring `X402PaymentRequirements<TExtra>` →
`CantonPaymentRequirements`. The seam is plural at both levels: a selector
returns a list, so one kind can offer several ways to pay.

Zero matches is settled before any scheme code runs; the selector then runs once
per matching kind, because until it has there is no way to know how many ways to
pay there are.

### What a canton-exact `extra` must carry

`transferMethods`, `synchronizerId` and `carriages` are required, and a kind
whose `extra` lacks one is not a canton-exact deployment. `instruments` stays
optional; what an absent or empty list means is below.

`cantonSupportedExtra` throws `MalformedSupportedExtraError` naming the field
rather than returning `{}`. Swallowing the failure would mean one bad key
discards every good one — the synchronizer and the instruments with it — and
the caller is then told the deployment "advertises no instrument", which is
false and unactionable. Unknown keys still pass: only the keys this scheme
defines are checked.

Because the advertised `synchronizerId` is required, the derived
`CantonDeploymentExtra.synchronizerId` is no longer optional.

### What it refuses

Not ambiguity — that is the merchant layer's call. But a preference nothing
matches is an error naming what the facilitator does settle — the kinds it has,
or the instruments it lists. Only that: how to change the request is the
caller's business, for the same reason there is no singular form.

So is a response that contradicts itself: an instrument whose top-level `admin`
and whose `instrumentId.admin` disagree is inconsistent about who validates the
holding, and quoting either half would be a guess at which is right.

### Also

The exported surface is `selectDeployments`, `selectCantonDeployments`,
`cantonSupportedExtra`, the two error types and the types themselves. Kind
filtering and canton's own extra selector stay internal — nothing outside needs
them, and `supported.kinds` is right there for anyone wanting the raw list.

Canton Coin is read only when a deployment lists it. The registered
implementation leaves it implied by the scheme and lists CIP-56 tokens only, so
discovery against one of those returns its other instruments and not CC. Ours
lists it explicitly, so this costs nothing here; a merchant on a deployment
that does not pins `network` and `asset`, which skips discovery. Implying it is
possible — the DSO is `DSO::` plus the advertised synchronizer's namespace —
and deliberately not done, so that a quote always rests on what a facilitator
answered rather than on a convention.

Nothing consumes this yet; the Express middleware does in a follow-up.

The docs now point at `extra.instruments[]` rather than the superseded
`extra.asset.instrumentId`, which says the same thing for one instrument only.
