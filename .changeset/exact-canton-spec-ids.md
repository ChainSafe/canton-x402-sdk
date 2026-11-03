---
"@chainsafe/x402-core": minor
"@chainsafe/x402-express": minor
"@chainsafe/x402-server-sdk": minor
---

**Breaking.** The scheme and network ids are the ones the registered Canton
scheme spec fixes. There is no alias and no grace period.

```diff
- "scheme":  "exact-canton",
- "network": "canton:1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef…",
+ "scheme":  "exact",
+ "network": "canton:devnet",
```

A conforming client could never pay us before: it reads `exact` and
`canton:mainnet|testnet|devnet` off the spec, and had no way to learn either
of the ids we actually used.

`createCantonExactVerifier(networkId)` now takes no options. `EXACT_SCHEME_ID`
is the only scheme constant; `EXACT_CANTON_SCHEME_ID` is gone. `MAINNET_NETWORK`
and `DEVNET_NETWORK` are the registered names rather than `canton:<fingerprint>`,
and `TESTNET_NETWORK` joins them.

`LOCALNET_NETWORK` (`canton:localnet`) is new, and `localnetConfig()`'s `network`
is now optional and defaults to it. The spec's table of three is not a closed set
— Rule 1 requires only a network the facilitator is configured for — so LocalNet
gets its own id instead of borrowing DevNet's, which would leave a local and a
real DevNet facilitator indistinguishable on the wire.

**The synchronizer fingerprint did not retire** — only its use as a network id
did. `*_SYNCHRONIZER_ID` and `*_DSO_PARTY` still carry it, and nothing is lost,
because neither side ever read the synchronizer out of the network id: a payer
gets it from the participant its wallet SDK is connected to, and a facilitator
from its own config.

**`requirementsHash` changes for every payment**, because the hash covers the
whole requirements object and two of its values are renamed. The algorithm is
untouched. Any golden vector pinned against it must be regenerated on both
sides of the wire in the same release.

**Renamed exact-canton → canton-exact**, because `exact-canton` was the retired
wire id and keeping it as the API's most visible name left a grep unable to tell
live code from history. The new order also matches the facilitator's existing
`V2CantonExact`.

```diff
- import { createExactCantonVerifier } from "@chainsafe/x402-core";
+ import { createCantonExactVerifier } from "@chainsafe/x402-core";
```

The chain stays in the name on purpose: `exact` is the scheme family across
chains (`specs/schemes/exact/…`), while this verifier is Canton-specific —
Canton key fingerprints, prepared-transaction decoding, `party::fingerprint`
suffixes.
