// Shared kernel — primitives used across the x402 wire contract.
// Spec: canton-x402 spec §5–§6.

/**
 * x402 protocol version — the envelope discriminant. Pinned to `2` today; widen
 * to a union (`2 | 3 | …`) here when a new protocol version lands, and every
 * envelope updates in one place.
 */
export type X402Version = 2;

/**
 * Network identifier carried in the (scheme-generic) envelope. Its concrete
 * format is scheme-dependent — `exact-canton` uses `canton:<synchronizer-id>`,
 * other schemes (e.g. an EVM bridge) use their own CAIP-2 id (`eip155:<chainId>`)
 * — so the shared type stays a plain string. The `canton:` shape is validated at
 * runtime by the exact-canton verify path (#5), not enforced here.
 *
 * FUTURE: once the envelope is parameterized per scheme, an exact-canton-specific
 * `CantonNetworkId = `canton:${string}`` can narrow this for that scheme only.
 */
export type NetworkId = string;

// FUTURE: introduce a shared open union so known schemes autocomplete while the
// envelope stays extensible, e.g.
//   export type Scheme = "exact-canton" | "batch-settlement-canton" | (string & {});
// Then use `Scheme` for the `scheme` fields (requirements/payload/supported).

/** Splice Token Standard instrument identifier. */
export interface InstrumentId {
  /** Instrument name. For Canton Coin: "Amulet". */
  id: string;
  /** Admin party ID for the instrument (e.g. DSO::1220...). */
  admin: string;
}

export interface AssetSpec {
  instrumentId: InstrumentId;
}

/**
 * A contract disclosed alongside a prepared transaction (Canton Ledger API
 * `DisclosedContract`).
 */
export interface DisclosedContract {
  templateId: string;
  contractId: string;
  /** Base64 `createdEventBlob` from the ledger. */
  createdEventBlob: string;
  synchronizerId: string;
}
