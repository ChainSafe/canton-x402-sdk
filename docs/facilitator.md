---
description: The guarantees verify enforces before any money moves, and what settlement does on Canton.
---

# The facilitator

This page zooms in on steps 5 and 6 of [the payment flow](/payment-flow), the
facilitator's half. Before any money moves, verify enforces a handful of
guarantees — your payment can't be replayed, tampered with, or under-paid — and
settle re-runs all of them before executing on Canton. The facilitator never
moves a payer's funds on its own authority: the only write that moves them is
`executeAndWaitForTransaction` of a **payer-signed** transaction.

## What verify guarantees

These run in order, with no chain write. The first seven are shared code — the
same `@chainsafe/x402-core` verifier the SDK exposes — so a payer can pre-flight
its payload against them, and they refuse with the Canton scheme spec's codes,
keeping the code they used before in `extensions.reason`. The last is the
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
4. **The key belongs to the payer** — the fingerprint derived from the
   payload's `publicKey` must match the `::` suffix of the transfer's sender,
   so a caller can't sign as a party it doesn't control
   (`invalid_exact_canton_signature_invalid` otherwise).
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
   policy). A destination denial comes back as `transfer_mismatch` with a
   `destination_not_allowed` detail on verify, and as `unauthorized` on settle.

## What settlement does

Funds are real Splice **Amulet** (Canton Coin), transferred through the Token
Standard's `TransferFactory` in one atomic Canton transaction. When your party
has a `TransferPreapproval`, that transfer is direct, so nothing is escrowed or
locked up; without one, the Token Standard makes it an offer that completes
only once you accept it. What is recorded is the signed transfer's amount, not
the quoted floor, so an overpayment is not understated.
