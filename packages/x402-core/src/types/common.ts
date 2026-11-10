// Shared kernel — primitives used across the x402 wire contract.
// Spec: canton-x402 spec §5–§6.
//
// Object shapes are defined schema-first with valibot: the schema is the single
// source of truth, and the exported type is inferred from it (`v.InferOutput`),
// so a field added to a schema flows straight to the type — no drift between the
// type and its validator. Scalar/union aliases below stay type-only where valibot
// can't express them (open unions, literal-2 version).

import * as v from "valibot";

/**
 * x402 protocol version — the envelope discriminant. Pinned to `2` today; widen
 * to a union (`2 | 3 | …`) here when a new protocol version lands, and every
 * envelope updates in one place.
 */
export type X402Version = 2;

/**
 * Network identifier carried in the (scheme-generic) envelope. Its concrete
 * format is scheme-dependent — on Canton it is a `canton:<name>` (see
 * ../networks), while other schemes (e.g. an EVM bridge) use
 * their own CAIP-2 id (`eip155:<chainId>`) — so the shared type stays a plain
 * string. The `canton:` shape is validated at runtime by the canton-exact verify
 * path (#5), not enforced here.
 */
export type NetworkId = string;

/**
 * Payment scheme identifier. Open union: the literal members are the schemes
 * *this package* defines (today just `exact`), so they autocomplete and a
 * typo is caught; the `(string & {})` tail keeps the envelope extensible, so a
 * scheme defined elsewhere (e.g. the facilitator's `batch-settlement-canton` /
 * `exact-evm-to-canton-cc`) is still assignable. Add a literal here when core
 * itself ships a verifier for that scheme.
 */
export type Scheme = "exact" | (string & {});

/**
 * How value moves for canton-exact: the payer signs a `TransferFactory_Transfer`
 * and the facilitator relays it. The protocol reserves the key name and leaves
 * the vocabulary to each mechanism; this is the only value Canton's `exact`
 * defines, so it is a literal rather than a union.
 */
export const ASSET_TRANSFER_METHOD = "transfer-factory";

/** Splice Token Standard instrument identifier. */
export const InstrumentIdSchema = v.object({
  /** Instrument name. For Canton Coin: "Amulet". */
  id: v.string(),
  /** Admin party ID for the instrument (e.g. DSO::1220...). */
  admin: v.string(),
});
export type InstrumentId = v.InferOutput<typeof InstrumentIdSchema>;

export const AssetSpecSchema = v.object({
  instrumentId: InstrumentIdSchema,
});
export type AssetSpec = v.InferOutput<typeof AssetSpecSchema>;

/**
 * A contract disclosed alongside a prepared transaction (Canton Ledger API
 * `DisclosedContract`).
 */
export const DisclosedContractSchema = v.object({
  templateId: v.string(),
  contractId: v.string(),
  /** Base64 `createdEventBlob` from the ledger. */
  createdEventBlob: v.string(),
  synchronizerId: v.string(),
});
export type DisclosedContract = v.InferOutput<typeof DisclosedContractSchema>;

/**
 * x402 v2 `ResourceInfo`: what is being paid for. A 402's `PaymentRequired`
 * names it, and a payment may carry it back. Only `url` is required. The
 * optional fields also take an explicit `null`, as other implementations send
 * it.
 */
export const ResourceInfoSchema = v.looseObject({
  url: v.pipe(v.string(), v.minLength(1)),
  description: v.nullish(v.string()),
  mimeType: v.nullish(v.string()),
  serviceName: v.nullish(v.string()),
  tags: v.nullish(v.array(v.string())),
  iconUrl: v.nullish(v.string()),
});
export type ResourceInfo = v.InferOutput<typeof ResourceInfoSchema>;

/**
 * x402 v2 `extensions`, on a `PaymentRequired` or a payment: extension id → its
 * data. Passed through, not interpreted.
 */
export const PaymentExtensionsSchema = v.record(v.string(), v.unknown());
export type PaymentExtensions = v.InferOutput<typeof PaymentExtensionsSchema>;
