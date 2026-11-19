---
"@chainsafe/x402-core": major
---

**Breaking.** A canton-exact transfer must now spend the payer's own holdings
of the quoted instrument, and they must cover the amount (spec Rule 13). Until
now verify never read the inputs, so a transfer that spent nothing, someone
else's holdings, or less than the amount answered `isValid: true` and failed
only when the ledger ran it.

Each refusal answers `invalid_exact_canton_insufficient_inputs`, names the
payer, and gives one of these as `extensions.detail`:

- `inputs_none`: `inputHoldingCids` is empty, absent, or not a list of contract
  ids.
- `inputs_repeated`: an id is declared more than once.
- `inputs_unresolved`: a declared id is not exactly one of the transaction's
  input contracts, or the contract it names cannot be read: it has no template
  id, its argument is not a record, or a label repeats at any depth of that
  record. It is refused, never skipped, even when the other inputs would cover
  the amount.
- `inputs_template`: the input is not a holding of the instrument's kind: a
  `Splice.Amulet:Amulet` for Canton Coin, a
  `Utility.Registry.Holding.V0.Holding:Holding` for any other instrument.
- `inputs_signatories`: its signatories are not exactly the instrument's admin
  and the sender.
- `inputs_owner`: its `owner` is not the sender.
- `inputs_admin`: its `dso` (Canton Coin) or `registrar` (registry) is not the
  instrument's admin.
- `inputs_instrument`: a registry holding's `instrument.id` is not the quoted
  instrument.
- `inputs_amount`: its amount is not a ledger amount. A Canton Coin holding's
  amount is its `amount.initialAmount`, since a transfer charges no holding fee
  on its inputs (CIP-0078).
- `inputs_short`: the amounts sum to less than the transfer's.

Each field is read at its declared type, and by declaration order when a label
is missing, as the rest of the transfer is. The check runs after the deadline
(Rule 10), so a payment that is both expired and short answers
`invalid_exact_canton_expired`.

**What to do:** nothing, for a payer that builds its transfer through the
ledger's prepare. That declares and discloses the inputs, and every real
payment decoded so far passes. A hand-built transaction must declare its
holdings in `inputHoldingCids` and disclose each one as an input contract.

**One honest payment is refused.** The wallet SDK's input selection skips a
`LockedAmulet` only while its lock is live, so it can choose one whose lock has
expired. Rule 13 names the plain `Amulet`, so that payment is refused as
`inputs_template`. `CantonX402Payer` cannot avoid this today: it takes
whatever the wallet SDK selects. A payer that builds its own transfer can pass
`inputUtxos` to `token.transfer.create`, naming plain Amulets only.

**Registry tokens** are read against the DA Utility Registry's `Holding`, the
registry whose transfer rule delivery already requires. Its layout
(`operator`, `provider`, `registrar`, `owner`, `instrument {source, id,
scheme}`, `label`, `amount`) is known from one real USDCx transfer. If a
registry's holding differs, its payments are refused with an `inputs_*` detail
rather than let through.

**Not checked:** whether an input is still unspent, and whether its disclosure
is genuine. The disclosure is part of what the payer signs, as the factory's
is. The ledger authenticates each input against its id and refuses a spent one
when the transfer executes.

`DecodedTransfer` gains an optional `inputs`: each declared id with the input
contract it names, the record's leaves kept at their Daml types. It is absent
when the transfer declares none.
