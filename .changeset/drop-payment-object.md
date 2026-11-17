---
"@chainsafe/x402-core": major
---

**Breaking.** `CantonPaymentObject` and its request/response types are removed,
with the `DisclosedContract` pair that existed only to serve them.

Nothing uses them. The facilitator removed `POST /payment-object` as unused
(#202) and has no reference to it anywhere; no x402 specification defines the
endpoint; and within this package the types were reachable only from the
barrel and one wire test.

The reason to delete rather than leave them is what they describe.
`CantonPaymentObject` carries `facilitatorFee` and `totalAmount` — a fee
structure still being designed. The next release is 1.0.0, so a shape that
ships now is frozen for the whole major, and this one would be frozen wrong.

`DisclosedContract` goes with it: its only consumer was this module, and the
one place a disclosed contract is actually handled takes its type from the
Canton wallet SDK rather than from here, so our copy was a second,
non-authoritative definition of a ledger shape.
