---
"@chainsafe/x402-client": major
"@chainsafe/x402-core": major
"@chainsafe/x402-express": major
"@chainsafe/x402-server-sdk": major
---

**Breaking.** The packages need Node 22.2 or later. `engines` was `>=20`.

Node 20 reached end of life on 2026-04-30. 22 is the oldest line still
supported, until 2027-04-30, so nobody has to move to the newest Node to use
the SDK. 22.2 is the first release of 22 with `zlib.crc32`, which the gzip
codec for the payload's `preparedTransaction` (#75) needs. The codec frames the
gzip member by hand and checks its CRC32 itself, because `gunzip` accepts the
concatenated members and trailing bytes that the Canton scheme says to refuse.

The build target moves from `node18` to `node22` to match.
