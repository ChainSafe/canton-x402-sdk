---
"@chainsafe/x402-server-sdk": patch
---

Preserve headers inherited from a Request during payment retries when init.headers is omitted or undefined. Explicit header replacements keep native fetch semantics.
