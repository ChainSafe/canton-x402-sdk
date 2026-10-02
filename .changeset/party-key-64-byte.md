---
"@chainsafe/x402-server-sdk": minor
---

`CantonPartyKey.privateKey` now accepts a 64-byte nacl secret key (`seed || publicKey`, as wallet-sdk generates) as well as a 32-byte seed. The seed half is used for signing after checking the public half matches `publicKey`; any other length is rejected when the payer is constructed.
