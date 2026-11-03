---
"@chainsafe/x402-core": patch
---

`decodePreparedTransaction` now refuses a prepared transaction that is not
canonically encoded along the path it reads: a singular field written more than
once, or more than one member of a oneof. Its view of the transaction then always
matches a full protobuf decoder's. Canton never produces such encodings, so real
transactions are unaffected; the verifier reports them as `transfer_mismatch`
(`undecodable`).
