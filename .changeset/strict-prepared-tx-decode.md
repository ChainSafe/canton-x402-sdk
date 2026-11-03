---
"@chainsafe/x402-core": patch
---

`decodePreparedTransaction` now reads a prepared transaction the way Canton
does. It refuses an encoding a full protobuf decoder would read differently (a
singular field written more than once, or more than one member of a oneof), and
reads only the node tree under the transaction's roots, refusing repeated node
ids, nodes outside that tree, and a transfer under a rollback node. Canton never
produces any of these, so real transactions are unaffected; the verifier reports
them as `transfer_mismatch` (`undecodable`).
