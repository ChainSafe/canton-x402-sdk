import type { AssetSpec, InstrumentId, NetworkId } from "./types/common";

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

// No TestNet or LocalNet fingerprint: we run neither, and a LocalNet instance
// allocates its DSO at runtime. Their network ids are above — a name needs no
// fingerprint, which is the point of the split.

/** The instrument id Canton Coin is registered under. */
export const AMULET_INSTRUMENT_ID = "Amulet";

/** Amulet (Canton Coin) instrument for a given DSO admin party. */
export function amuletAsset(dsoParty: string): AssetSpec {
  return { instrumentId: { id: AMULET_INSTRUMENT_ID, admin: dsoParty } };
}

/**
 * The spec's `asset` for an instrument: a symbol, not a descriptor.
 * `PaymentRequirements.asset` is `"CC"` for Canton Coin, or a registry token's
 * own symbol — the full `{admin, id}` travels in `extra.instrumentId`, because
 * a symbol alone cannot say which registry issued it.
 *
 * Canton Coin is the one case where the two differ: its instrument is `Amulet`
 * and its symbol is `CC`.
 */
export function assetSymbol(instrumentId: InstrumentId): string {
  return instrumentId.id === AMULET_INSTRUMENT_ID ? "CC" : instrumentId.id;
}
