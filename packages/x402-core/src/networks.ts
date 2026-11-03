import type { AssetSpec, NetworkId } from "./types/common";

// Network-identity constants (public, non-secret). Connection/auth config
// (ledger URLs, OAuth creds, scan-proxy) is runtime and lives in the server-sdk,
// not here.

// Default synchronizer hint, prefixed onto a fingerprint for the canonical
// `<hint>::<fingerprint>` synchronizer id. Derivation detail — the concrete
// synchronizer id is what consumers actually use.
const SYNCHRONIZER_HINT = "global-domain";

// For a given network the network id, synchronizer id, and DSO party all share
// the synchronizer namespace fingerprint, so each set derives from one fp.
// (Localnet's DSO is allocated at runtime, so no localnet constants here.)
//
// `canton:<fp>` is the wire-format network id (no hint); `<hint>::<fp>` is the
// canonical synchronizer id that ledger APIs (e.g. interactive-submission
// prepare) expect; `DSO::<fp>` is the Amulet instrument admin.

// THE NETWORK IDS WE ARE MOVING TO.
//
// The registered Canton scheme spec (specs/schemes/exact/scheme_exact_canton.md)
// fixes exactly these three as the `network` on a payload, on requirements, and
// in `/supported`. We use `canton:<fp>` instead (DEVNET_NETWORK and
// MAINNET_NETWORK below), which is not registered, so a conforming client has
// never seen it and cannot pay us at all.
//
// The migration mirrors the scheme id's (EXACT_CANTON_SCHEME_ID): accept both,
// advertise the registered one, then drop `canton:<fp>` — at which point the
// `*_NETWORK` constants below go with it. They are transitional; these are not.
//
// THE FINGERPRINT IS NOT WHAT RETIRES. Only its use as a network id does. The
// synchronizer it names is still needed to build a transfer, and it keeps its
// own constants below — `*_SYNCHRONIZER_ID` for the ledger API, `*_DSO_PARTY`
// for the Amulet admin — while the spec carries it on the wire as
// `extra.synchronizerId`.
//
// NAMES, NOT A MAPPING. Nothing here pairs a fingerprint with a registered id,
// deliberately: that pairing is a fact about a running deployment, and a library
// encoding it would be carrying someone's configuration. A deployment states its
// own when it builds a verifier (`acceptNetworks`, verify/exact-canton.ts).
export const SPEC_MAINNET_NETWORK: NetworkId = "canton:mainnet";
export const SPEC_TESTNET_NETWORK: NetworkId = "canton:testnet";
export const SPEC_DEVNET_NETWORK: NetworkId = "canton:devnet";

// ChainSafe Canton DevNet.
const DEVNET_SYNCHRONIZER_FP =
  "1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a";

export const DEVNET_NETWORK: NetworkId = `canton:${DEVNET_SYNCHRONIZER_FP}`;
export const DEVNET_SYNCHRONIZER_ID = `${SYNCHRONIZER_HINT}::${DEVNET_SYNCHRONIZER_FP}`;
export const DEVNET_DSO_PARTY = `DSO::${DEVNET_SYNCHRONIZER_FP}`;

// Canton MainNet (Global Synchronizer).
const MAINNET_SYNCHRONIZER_FP =
  "1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";

export const MAINNET_NETWORK: NetworkId = `canton:${MAINNET_SYNCHRONIZER_FP}`;
export const MAINNET_SYNCHRONIZER_ID = `${SYNCHRONIZER_HINT}::${MAINNET_SYNCHRONIZER_FP}`;
export const MAINNET_DSO_PARTY = `DSO::${MAINNET_SYNCHRONIZER_FP}`;

/** Amulet (Canton Coin) instrument for a given DSO admin party. */
export function amuletAsset(dsoParty: string): AssetSpec {
  return { instrumentId: { id: "Amulet", admin: dsoParty } };
}
