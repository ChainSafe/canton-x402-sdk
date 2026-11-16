---
"@chainsafe/x402-core": major
---

**Breaking.** One decoder. The hand-rolled prepared-transaction walker is gone;
`decodePreparedTransaction` now reads the transaction through
`@canton-network/core-tx-visualizer` — the same decode the signing hash is
taken over — and refuses unknown protobuf fields.

The walker guarded the wrong boundary. Its stated goal was agreeing with
Canton's protobuf-java, but the payer's signature covers a hash computed from
the vendor's parse. Strictness applied to a third parser sitting outside the
hash protects nothing; worse, the requirements were being bound to the walker's
reading while the signature committed to the vendor's — two readings of one
blob, where an attacker wins by making them disagree. Deleting it takes three
parsers to two, and the survivor is the hash's own.

`decodePreparedTransaction`, `DecodedTransfer` and `MEMO_KEY` keep their names
and shapes, including the `| null` channel, so no import changes.

**What is now refused that was not.** The decode runs with
`readUnknownField: "throw"`, so a prepared transaction carrying a field the
schema does not define is rejected rather than read past. That is the point: the
hash cannot cover a field it cannot see, so reading past one meant binding the
requirements to bytes nobody signed. The hasher refuses the same input.

**What is now accepted that was not.** A singular SCALAR field written twice,
or a node carrying two known node types. Protobuf keeps the last of those, and
so does the decode the hash is taken over — so refusing them was the walker
disagreeing with the ledger rather than catching anything. Eight tests pinning
those refusals are removed and one is added in their place, pinning that a
repeated singular scalar now reads LAST, as the ledger reads it.

**A repeated MESSAGE field is a different thing, and is refused.** Two copies
of a message do not last-wins: protobuf merges them, and merging concatenates
their repeated members. A chosen value written twice therefore decodes as one
record carrying `expectedAdmin, transfer, expectedAdmin, transfer` — and a
reader taking the first would bind the requirements to a benign transfer while
the signature covers a second paying someone else. `fieldsOf` now refuses a
record whose labels repeat, which a Daml record never does honestly. Only the
labeled form is caught; a fully-positional record doubled the same way
concatenates into indices nothing can tell apart, and the ledger's arity check
is what refuses that.

**What is kept.** Every structural invariant: exactly one root, the transfer is
that root, no transfer under a rollback, no duplicate or unreachable nodes. And
`canonicalNodeId`, moved into `prepared-tx-guard.ts` and applied where a node is
defined — the one check the hash genuinely does not backstop, since node ids are
absent from its preimage and the decode keys nodes by raw string, making "0" and
"00" two nodes here and one at the ledger.

`prepared-tx-hash.test.ts` gains a test pinning the property this rests on: that
the hash moves when the decoder's output moves, and refuses what the decoder
refuses. It did not hold on core-tx-visualizer 1.7.0, so it is pinned rather
than assumed.
