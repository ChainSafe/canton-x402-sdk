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

These run in order, with no chain write. The first six are shared code — the
same `@chainsafe/x402-core` verifier the SDK exposes — so a payer can pre-flight
its payload against them. The last is the facilitator's alone, since only it
holds the state involved:

1. **Right scheme and network** — the payload, the requirements, and the
   network this facilitator is bound to all agree.
2. **Still valid** — `validBefore` is still in the future.
3. **Bound to your exact terms** — the payload's `requirementsHash` must match
   the requirements it is verified against. That hash covers `payTo`,
   `maxAmountRequired`, `resource` and `nonce`, so it proves the payload refers
   to your terms; check 6 proves the signed transfer satisfies them.
4. **The key belongs to the payer** — the fingerprint derived from the
   payload's `publicKey` must match the `::` suffix of the payer's party id, so
   a caller can't sign as a party it doesn't control.
5. **The signature is valid** — the payer's key signed the prepared
   transaction's hash, and Canton checks that signature against the
   transaction itself when settle executes it.
6. **The signed transfer actually pays you.** The prepared transaction is
   decoded and its sender, receiver, instrument and amount are checked against
   the requirements, so a valid signature over a divergent transfer is rejected
   with `transfer_mismatch` and the field that diverged. Overpaying is allowed;
   underpaying is not.
7. **No replay, and you're an allowed destination** — the nonce has not been
   used before (the facilitator tracks that), and for an authenticated merchant
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
