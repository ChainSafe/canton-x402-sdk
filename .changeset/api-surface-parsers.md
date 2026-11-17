---
"@chainsafe/x402-core": major
"@chainsafe/x402-express": major
---

**Breaking.** The five `parse*` functions are no longer exported, and the two
requirements schema objects are replaced by a published key union.

**`parseCantonPaymentInner`, `parseCantonPaymentPayload`,
`parseCantonPaymentRequirements`, `parseCantonVerifyRequest` and
`parseX402Request`** are now internal. They throw valibot's `ValiError`, so
exporting them made the validation library part of this package's public API —
a heavy commitment for five functions with no consumer in any repo. The `is*`
guards remain and cover every observed use. If a caller ever needs a reason
rather than a boolean, a core-owned error type can be added without breaking
anyone: re-exporting is a minor, un-exporting is not.

**`CantonRequirementsExtraSchema` and `CantonPaymentRequirementsSchema`** are no
longer exported either. They were reachable only so a caller could read
`.entries` to get the set of keys. `CantonRequirementsExtraKey` now names that
set directly, because the type cannot: `CantonRequirementsExtra` is inferred
from a `looseObject`, so it carries an index signature and `keyof` on it
collapses to `string`.

`@chainsafe/x402-express` moves to the new shapes in the same release — its
rule-table drift check uses `CantonRequirementsExtraKey`, and its policy table
uses `keyof CantonPaymentRequirements`, which is identical since that schema is
a plain object.
