---
---

Internal only: the verifier is split into modules — `primitives`, `record-fields`,
`transfer-binding` and `transfer-rules` — and its functions are named for what they
check rather than for where they sit. No rule changed, and the published surface is
unchanged at 108 names, which `api-surface.txt` holds in CI.
