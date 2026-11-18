---
"@chainsafe/x402-core": major
"@chainsafe/x402-server-sdk": major
---

**Breaking. The payload no longer carries the payer's public key; a facilitator
reads it from the ledger instead (#105).**

The spec's `payload` never had a `publicKey`, and ours admitted as much in its
own comment: it stayed "until the facilitator can read the sender party's keys
from the ledger". It can now — Canton 3.7's
`GET /v2/jose/jwks/synchronizer/{id}/party/{party}` returns a party's Ed25519
keys on the same JSON Ledger API a facilitator already authenticates to.

### If you build payloads

`CantonPaymentInner.publicKey` is gone, and so is `CantonPartyKey.publicKey` —
it fed only that field. `@chainsafe/x402-server-sdk` drops it from the payloads
it signs; nothing else is needed, since the private seed is what signs and the
party id already carries the fingerprint.

### If you call the verifier

`SchemeVerifier.verify` and `VerifierRegistry.verify` take a third argument: the
scheme's own **context**, the facts a caller must resolve before verifying. For
Canton `exact` that is `CantonVerifyContext`, `{ payerPublicKeys }` — the payer
party's PUBLIC signing keys, which the CALLER reads from the ledger. The payer
is the transfer's sender, which `decodePayloadTransfer` reads without verifying
anything, so a facilitator decodes, looks the party up, then verifies. Core
stays synchronous and reads nothing itself.

A context object rather than a bare array because `SchemeVerifier` is
scheme-agnostic and another scheme needs other facts. It is generic —
`SchemeVerifier<TContext = unknown>` — so a registry still holds verifiers for
different schemes side by side, while a concrete verifier type-checks its own
callers. Reach for the bare `SchemeVerifier` and the context is `unknown`,
which accepts anything: name the context type when you hold one verifier.

### Which key signed

A successful verify now answers `extensions.signedBy`: the fingerprint of the
key the signature actually verified under.

A Canton submission names one key per signature in `partySignatures.signedBy`,
and until now a facilitator derived it from the payload's `publicKey`. That
field is gone, and the payer's `::` suffix is NOT a substitute — it is the
party's NAMESPACE fingerprint, which equals a signing key's only while the
party publishes one. A party mid-rotation publishes two, so the suffix can name
a key that did not sign: verify would pass and the ledger would refuse the
submission, after the facilitator had already committed.

Core knows which key verified, because it just searched for it. Handing it back
costs nothing and keeps one answer to "which key signed" rather than two that
can drift — which matters here, since Ed25519 validity is encoding-sensitive
and a second verifier would be free to disagree.

A list because that is the shape the sources have — a JWKS `keys[]`, Canton's
`partySigningKeys.keys[]` — and because a party may publish **up to 20** signing
keys. The payload does not say which one signed, so any of them verifying is the
party verifying. Passing a party's whole set is correct; passing none refuses
the payment.

**Standard base64, not base64url.** Core decodes a key with `atob`, which
refuses `-` and `_`, while a JWKS serves its `x` as base64url. Roughly three
keys in four contain a byte that the two spell differently, so passing `jwk.x`
through unconverted refuses most payments — and refuses them *quietly*:
`verifySignature` answers false rather than throwing, so an undecodable key is
indistinguishable from a key that did not sign, and the payer is blamed for a
bad signature. Convert before calling.

The keys are NOT narrowed to the one whose fingerprint equals the party's `::`
suffix. That suffix is the party's NAMESPACE fingerprint, equal to the signing
key's only for a single-key party, so narrowing would refuse an honest payment
from a party mid key-rotation. What binds a key to the sender is that the caller
looked it up BY that party id.

### One wire change beyond the field

A payer whose key cannot be resolved was previously refused at the envelope, as
`invalid_exact_canton_missing_proof` with **no payer**, because the missing key
was a missing proof. There is no key in the payload to miss now, so the refusal
happens after the transfer decodes: `invalid_exact_canton_signature_invalid`,
**naming the payer**, with `missing_public_key` still in `extensions.reason`.
That matches the reference implementation, which answers `signature_invalid`
when its own key lookup returns nothing.

### Not covered

A party with a signing threshold above 1 needs more than one signature, and an
x402 payload carries exactly one. Nothing here reads the threshold, so such a
payment passes verify and is refused by the ledger at submission. The JWKS route
does not return the threshold; the participant's admin API does.
