---
"@chainsafe/x402-core": major
---

**Breaking.** Read a record's fields the way the engine binds them, and read
each field at its declared type.

**The quantifier was inverted.** Daml binds a record BY LABEL only when EVERY
field carries one; a single unlabeled field puts the whole record in
DECLARATION ORDER, with each label that remains checked against the name
declared at its own index. `value.proto` says the same: with all keys present
the order does not matter, with any key omitted the order MUST match the
declaration. This read `some` where the engine reads `every`, which handed the
choice of mode to whoever wrote the blob.

Blanking ONE label was enough. The engine stayed positional and bound every
field correctly, so the transfer settled; we switched to the label path, the
lookup for the blanked field missed, and the field came back `undefined` — not
refused, dropped. Blanking only `meta` made verify report "this transfer
carries no memo" about a transfer carrying one, which is the harm the
both-ways memo check exists to prevent. A merchant quoting no memo and
reconciling by memo is who that costs.

**Types were read by coincidence.** One reader rendered party, text and numeric
alike, so it could not tell a `Party` from a `Text`. `InstrumentId` is declared
`{admin: Party, id: Text}`; a sub-record written at the wrong types read back
as a well-formed instrument. Each field is now read at its declared type.

**The positional indices for `InstrumentId` were backwards** — `{admin, id}`
in the DAR and in every capture, read as `{id, admin}` here. The test encoder
had them backwards too, so the positional round-trip tests agreed with the
mistake that wrote them and could not catch it. Both sides are corrected;
reverting either now fails four existing tests.

Each arm is pinned by its own case: the quantifier, the position check, the
three typed reads, and the indices. Honest traffic is unaffected — a prepared
transaction's choice argument arrives fully labeled in declaration order.
