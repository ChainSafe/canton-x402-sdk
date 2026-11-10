---
"@chainsafe/x402-core": patch
"@chainsafe/x402-express": minor
"@chainsafe/x402-server-sdk": major
---

The payment travels in `PAYMENT-SIGNATURE`, the header the x402 v2 HTTP
transport names for it.

- `@chainsafe/x402-express` reads `PAYMENT-SIGNATURE`, and falls back to
  `X-PAYMENT`, the name this SDK used before, when it is absent or empty. A
  request carrying both is read from `PAYMENT-SIGNATURE`. The fallback is for a
  payment of this release's shape sent under the old name: a 0.1.x payer sends
  the older shape, which is refused either way.
- **Breaking, in `@chainsafe/x402-server-sdk`:** `createX402Fetch` sends the
  payment in `PAYMENT-SIGNATURE` only, not in both, since a second copy would
  double a header of about 10 KB. A merchant on this release's middleware reads
  it. One on an older middleware could not read this release's payment shape
  anyway.
- `@chainsafe/x402-core`'s codec errors say "payment header" rather than
  `X-PAYMENT`.

The docs carry the scheme spec's size guidance: every server and proxy on the
way should accept at least 16 KiB for this header, and nginx's default refuses
any single header over 8 KiB.
