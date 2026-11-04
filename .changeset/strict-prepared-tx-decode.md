---
"@chainsafe/x402-core": patch
---

`decodePreparedTransaction` now reads a prepared transaction the way Canton
does. It refuses an encoding a full protobuf decoder would read differently (a
singular field written more than once, more than one member of a oneof, a tag
or length longer than 5 bytes, invalid UTF-8, groups), reads only the node tree
under the transaction's roots, and refuses repeated or non-canonical node ids,
nodes outside that tree, and a transfer under a rollback node. Canton never
produces any of these, so real transactions are unaffected; the verifier
reports them as `transfer_mismatch` (`undecodable`).
