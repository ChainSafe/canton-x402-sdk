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
