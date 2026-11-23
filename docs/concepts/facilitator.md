---
description: What the facilitator does, why it is non-custodial, where your API key fits, the guarantees verify enforces, and what settlement does on Canton.
---

# The facilitator

`x402` makes an ordinary HTTP request payable: a client that calls a paid
endpoint gets back `402 Payment Required`, signs a payment, and retries with
it. The **facilitator** is the HTTP service that turns that signed payment into
a real, settled payment on the Canton Network — so your server never has to
speak to a ledger, hold a wallet, or run a node. Your server (the resource
server) just hands each payment to the facilitator, which does exactly two
things with it: `POST /v2/verify` checks a signed payment against your terms
without submitting or reserving anything; `POST /v2/settle` then executes it on
Canton and returns the update id.

## Non-custodial by construction

Canton settles in three steps — `prepare`, `sign`, `execute` — and that split
is what makes the facilitator non-custodial. The payer does `prepare` and
`sign` with its own key, without going through the facilitator. The
facilitator only ever performs the final `execute` of a transaction the payer
already signed: it never sees a private key, and it cannot move funds without
that signature.

## The payment scheme

- `exact` on a `canton:*` network — the payer transfers Canton Coin (Amulet)
  directly to your party; you receive CC.

[`GET /v2/supported`](/reference/http-api#get-v2-supported) is the authority on
what a given facilitator accepts — the network id and the asset to pay in.

## How you get paid

Settlements land directly at your **Canton party** — the payout party of the
project your API key belongs to. The payer transfers Amulet (CC) straight to
it; the facilitator holds no balance, so there is nothing to withdraw. That
requires your payout party to hold a live `TransferPreapproval`. Without one,
Amulet cannot pay it directly — the Token Standard turns the transfer into an
offer the party must accept — so the facilitator **refuses** the payment rather
than relaying one that lands somewhere the payer can still withdraw it (see
[What settlement does](#what-settlement-does)). Completed
settlements show up on the Settlements page of the merchant dashboard.

## Your API key is the facilitator credential

A key you create on the API keys page of the merchant dashboard is what your
server sends as `Authorization: Bearer` to `/v2/verify` and `/v2/settle`. You
can create and rotate keys in the dashboard yourself — no facilitator redeploy
— and the key itself is never stored: what is kept is its hash, plus its
`sk_live_`/`sk_test_` prefix and last four characters so you can tell your keys
apart. A revocation can take up to a
couple of minutes to take effect.

## What verify guarantees

Steps 5 and 6 of [the payment flow](/concepts/payment-flow) are the
facilitator's half. Before any money moves, verify enforces a handful of
guarantees — your payment can't be replayed, tampered with, or under-paid — and
settle re-runs all of them before executing on Canton. The facilitator never
moves a payer's funds on its own authority: the only write that moves them is
`executeAndWaitForTransaction` of a **payer-signed** transaction.

These run in order, with no chain write. The first seven are shared code — the
same `@chainsafe/x402-core` verifier the SDK exposes — so a payer can pre-flight
its payload against them, and they refuse with the Canton scheme spec's codes,
saying in `extensions.detail` which of a code's causes it was. The last is the
facilitator's alone, since only it holds the state involved:

1. **Right scheme and network** — the payload, the requirements, and the
   network this facilitator is bound to all agree (`unsupported_scheme` or
   `invalid_network` otherwise).
2. **The transaction decodes** — `preparedTransaction` is one gzip member
   within the size caps, its node graph is well-formed, and it holds the one
   transfer. Its sender is the payer (the payload names none), and checks 3 to
   6 report it. A payload missing its proof is
   `invalid_exact_canton_missing_proof`, and one that does not decode is
   `invalid_exact_canton_malformed_payload`.
3. **Still executable** — the signed transfer's own `executeBefore` is far
   enough in the future to settle (`invalid_exact_canton_expired`). The quote itself no
   longer expires; the deadline that counts is inside what the payer signed.
4. **The keys belong to the payer** — the payload carries none. The
   facilitator reads the sender party's signing keys from the ledger, by that
   party id, and it is the lookup that binds them to the payer, so a caller
   can't sign as a party it doesn't control
   (`invalid_exact_canton_signature_invalid` when none can be resolved).
5. **The signature is valid** — the hash recomputed from the transaction
   itself must equal `preparedTxHash`, and the payer's key must have signed it
   (`invalid_exact_canton_signature_invalid` otherwise).
6. **The signed transfer actually pays you.** This is what binds the payment to
   your terms: the transfer's receiver, instrument and amount are checked
   against the requirements, so a valid signature over a divergent transfer is
   rejected: `invalid_exact_canton_merchant_mismatch`,
   `invalid_exact_canton_instrument_id_mismatch`,
   `invalid_exact_canton_amount_mismatch` or
   `invalid_exact_canton_memo_mismatch`. The amount
   must be EQUAL, not merely sufficient — `exact` is the scheme's
   distinguishing property, and a payer who overpays has no refund path. The
   transfer's `x402.memo` must equal your `extra.memo` exactly — in both
   directions, so a transfer carrying a memo you did not quote is refused as
   well.
7. **The transfer went through a real factory** — the contract the transfer
   choice was exercised on must be one the transaction itself discloses,
   exercised through the Token Standard `TransferFactory` interface, and
   carrying the instrument's admin among its signatories
   (`invalid_exact_canton_malformed_payload`, with a `factory_` detail naming
   which part failed). Without it a payer could exercise a contract of their
   own that merely exposes a choice of the same name, and the payment would
   reduce to "something called transfer happened". The disclosure travels
   inside what the payer signed, so this check takes it on the payer's word;
   the synchronizer authenticates it against the contract id at submission,
   which is where a fabricated one fails.
8. **No replay, and you're an allowed destination** — the payment has not
   settled before (the ledger is the real guard: a replayed transfer names
   input holdings that are already spent), and for an authenticated merchant
   `payTo` must be a party that key is allowed to receive at (your destination
   policy). A destination denial comes back as
   `invalid_exact_canton_merchant_not_registered` with a
   `destination_not_allowed` detail, on verify and on settle alike.

## What settlement does

Funds are real Splice **Amulet** (Canton Coin), transferred through the Token
Standard's `TransferFactory` in one atomic Canton transaction. Your party must hold a live
`TransferPreapproval`: with one the transfer is direct, so nothing is escrowed
or locked up. Without one the Token Standard would make it an offer that
completes only once you accept it — which is not a payment the facilitator can
stand behind, since the resource is already served while the funds sit where
the payer can withdraw them. Such a payment is refused at verify, with
`invalid_exact_canton_preapproval_missing`. What is recorded is the signed transfer's amount, not
the quoted floor, so an overpayment is not understated.
