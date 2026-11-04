---
"@chainsafe/x402-client": major
"@chainsafe/x402-core": major
"@chainsafe/x402-express": major
"@chainsafe/x402-server-sdk": major
---

**Breaking.** The payload's `preparedTransaction` is base64 of one gzip
member, as the Canton scheme spec defines, instead of base64 of the bare
protobuf. A typical transfer goes from 22-27 KB to about 5 KB, which keeps
the `X-PAYMENT` header near 10 KB.

The verifier reads it only as exactly one gzip member with no optional header
fields, at most 8 KiB compressed and 64 KiB decompressed, the spec's
recommended bounds. Concatenated members, bytes after the member, bytes
between the deflate stream and the trailer, and a trailer that does not match
are refused, and a decompression bomb stops at the bound. Anything else is
`transfer_mismatch` with detail `undecodable`.

New in `@chainsafe/x402-core`: `gzipPreparedTransaction` and
`gunzipPreparedTransaction`, with `DEFAULT_MAX_COMPRESSED_BYTES` and
`DEFAULT_MAX_DECOMPRESSED_BYTES`. `CantonX402Payer` gzips what prepare returns.

**For a facilitator.** Gunzip the payload's value once and use those bytes in
both places that read the transaction: the ledger's execute takes the bare
protobuf, and so does `decodePreparedTransaction`. Passing it the gzipped value
returns `null`, so a settled amount read from it would silently fall back.

**Core needs Node.** The codec uses `node:zlib`, and core's entry point exports
it, so `@chainsafe/x402-core` now runs on Node only (22.2 or later, for
`zlib.crc32`) and no longer bundles for a browser.
