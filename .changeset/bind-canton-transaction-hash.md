---
"@chainsafe/x402-core": major
---

Breaking: Recompute the canonical Canton prepared-transaction hash during verification, reject signed hashes that do not match the submitted transaction, and bound and validate the transaction graph before hashing. `SchemeVerifier.verify` and verifier-registry verification now return `Promise<VerifyResponse>`.