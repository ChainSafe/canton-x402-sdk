---
"@chainsafe/x402-core": patch
---

`DEFAULT_MAX_DECOMPRESSED_BYTES` is 72 KiB, not the 64 the scheme recommends.
Canton 3.7 grew the fixed overhead of a prepared transaction from about 13 KiB
to about 25 KiB while the cost of an input stayed flat at 5086 bytes, so a
payer spending eight holdings inflates to 66213 bytes and was refused as
`invalid_exact_canton_malformed_payload` by 677 of them — 1% of the bound, for
a payment with nothing wrong with it.

72 and no more. `DEFAULT_MAX_COMPRESSED_BYTES` stays at 8 KiB and is what binds
next: nine holdings gzip to about 8.2 KiB and are refused before this bound is
read, so 72 KiB admits everything 8 KiB of gzip can carry and a larger value
would buy no payer anything. The compressed cap does not contain a
decompression bomb — gzip reaches 1026:1, so 8 KiB of member can ask for 8 MB —
and this bound is the only thing that refuses one, which is the reason to take
the smallest value that does the job.

Nothing changes on the wire: the header carries the compressed member, whose
cap is untouched. Both bounds remain per-call overridable through
`PreparedTransactionLimits`, and the scheme's requirement is that bounds exist
and abort incrementally, which this keeps. A facilitator on the recommended
64 KiB still refuses the payer this admits, so the portable fix is an amendment
to the recommendation.
