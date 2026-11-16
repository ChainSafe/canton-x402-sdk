---
"@chainsafe/x402-core": patch
---

Upgrade `@canton-network/core-tx-visualizer` from `~1.7.0` to `^1.16.0`, which
fixes a wrong Canton V2 signing hash.

1.7.0 encodes a Daml `Int64` through `parseInt`:

```js
} else if (value.sum.oneofKind === "int64") {
    await encodeInt64(parseInt(value.sum.int64))      // a double
} else if (value.sum.oneofKind === "timestamp") {
    await encodeInt64(BigInt(value.sum.timestamp))    // correct
```

`parseInt` returns a double, so any `Int64` beyond 2^53 hashes wrong and two
different values can produce the same hash — on the path where the payer's
Ed25519 signature is verified. The asymmetry with the adjacent `timestamp`
branch is what makes it a bug rather than a scheme choice.

Upstream extracted the hashing into `@canton-network/core-tx-hashing`, which
1.16.0 depends on and delegates to. That package has no `parseInt` anywhere,
passes `sum.int64` through, and adds the traversal bounds (`DEFAULT_LIMITS`,
`maxDepth`, `maxNodes`) that 1.7.0's hasher had nowhere — on a path that runs
over attacker-supplied base64 BEFORE the signature is checked.

An upgrade rather than a switch: `decodePreparedTransaction` and
`hashPreparedTransaction` keep their names and signatures, every new parameter
is optional, and the three import sites compile unchanged.

**The payment path is unchanged.** Differentially hashed across both versions:
the committed vector, the facilitator's own captured LocalNet
`TransferFactory_Transfer` (identical on both, and equal to the payer's signed
hash), and the 24 V2 plus 7 mutation vectors upstream captures from a Canton
3.5.10 / protocol-35 participant. Exactly ONE input class hashes differently,
and it is the bug: a Daml `Int64` beyond 2^53.

**Behaviour change, fail-closed.** 1.16.0 refuses a prepared transaction
carrying protobuf fields it does not know, where 1.7.0 hashed past them. On our
own LocalNet fixture with an unknown top-level field appended, 1.7.0 returns the
*unchanged* hash — it hashed a blob carrying bytes it could not see — and
1.16.0 throws `TxHashingError: … the hash would not cover it`. The verifier
already wraps the hash call and fails closed, so this surfaces as
`invalid_exact_canton_malformed_payload`.

That is correct, but it is a cliff worth recognising in logs: if a payer's
participant runs a Canton newer than this package's `core-ledger-proto` and
populates a new `PreparedTransaction` field, every such payment is refused
rather than verified. Under 1.7.0 it would have been hashed — wrongly, against
bytes the hash did not cover. Failing is the right answer; the point is that the
failure is a version skew, not a bad payer.
