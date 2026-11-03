import type { AssetSpec, NetworkId } from "./types/common";

// Network-identity constants (public, non-secret). Connection/auth config
// (ledger URLs, OAuth creds, scan-proxy) is runtime and lives in the server-sdk,
// not here.

// Prefixed onto a fingerprint for the canonical `<hint>::<fingerprint>` form
// the ledger APIs want (e.g. interactive-submission prepare).
const SYNCHRONIZER_HINT = "global-domain";

// Network ids, carried as `network` on a payload, on requirements, and in
// `/supported`. A name, not a synchronizer fingerprint; which synchronizer a
// name points at is deployment config.
//
// The first three are the ones the registered Canton scheme spec names
// (specs/schemes/exact/scheme_exact_canton.md). Its table is not a closed set —
// Rule 1 requires only a network the facilitator is configured for — so
// LocalNet gets its own id rather than borrowing DevNet's, which would leave a
// local and a real DevNet facilitator indistinguishable on the wire.
export const MAINNET_NETWORK: NetworkId = "canton:mainnet";
export const TESTNET_NETWORK: NetworkId = "canton:testnet";
export const DEVNET_NETWORK: NetworkId = "canton:devnet";
export const LOCALNET_NETWORK: NetworkId = "canton:localnet";

// ChainSafe Canton DevNet.
const DEVNET_SYNCHRONIZER_FP =
  "1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a";

export const DEVNET_SYNCHRONIZER_ID = `${SYNCHRONIZER_HINT}::${DEVNET_SYNCHRONIZER_FP}`;
export const DEVNET_DSO_PARTY = `DSO::${DEVNET_SYNCHRONIZER_FP}`;

// Canton MainNet (Global Synchronizer).
const MAINNET_SYNCHRONIZER_FP =
  "1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";

export const MAINNET_SYNCHRONIZER_ID = `${SYNCHRONIZER_HINT}::${MAINNET_SYNCHRONIZER_FP}`;
export const MAINNET_DSO_PARTY = `DSO::${MAINNET_SYNCHRONIZER_FP}`;

// No TestNet or LocalNet constants: we run neither, and LocalNet allocates its
// DSO at runtime.

/** Amulet (Canton Coin) instrument for a given DSO admin party. */
export function amuletAsset(dsoParty: string): AssetSpec {
  return { instrumentId: { id: "Amulet", admin: dsoParty } };
}
