// The canton-exact scheme, as the middleware sees it.
//
// Everything canton-specific: the shape of `extra`, how an echoed one is
// compared, where the merchant's reference sits inside it, and how the
// deployment's own terms are read from the facilitator.
//
// SPDX-License-Identifier: Apache-2.0

import type { Request } from "express";
import {
  ASSET_TRANSFER_METHOD,
  assetSymbol,
  CantonRequirementsExtraSchema,
  decodePayloadTransfer,
  isCantonPaymentPayload,
  isCantonPaymentRequirements,
  selectCantonDeployments,
  type AssetSpec,
  type CantonPaymentPayload,
  type CantonPaymentRequirements,
  type CantonDeploymentPreference,
  type CantonDeploymentTerms,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from "@chainsafe/x402-core";

import {
  resolve,
  type BaseRequirementsSpec,
  type RuleTable,
  type Resolvable,
  type SchemeAdapter,
  type SchemeContext,
  type SchemeQuote,
} from "../scheme.js";

const DEFAULT_EXECUTE_BEFORE_SECONDS = 120;

/** Declarative requirements for canton-exact. */
export interface CantonRequirementsSpec extends BaseRequirementsSpec {
  /**
   * What this way to pay is priced in. Required, since `amount` is atomic
   * units of whatever this names.
   *
   * An **instrument id** names it and leaves the registry `admin` to
   * `GET /v2/supported` — the party the facilitator validates the payer's
   * holding against:
   *
   * ```ts
   * asset: "Amulet"   // Canton Coin. NOT "CC" — that is the wire SYMBOL, and
   *                   // Amulet is the one instrument whose id differs from it.
   * asset: "USDCx"    // id and symbol match here
   * ```
   *
   * An {@link AssetSpec} pins the admin too. With `network` it is the whole
   * answer and nothing is looked up; on its own, `/v2/supported` is still read
   * for the network — narrowed to this instrument, so the network quoted is
   * one that settles it:
   *
   * ```ts
   * asset: { instrumentId: { id: "Amulet", admin: "DSO::1220…" } }
   * ```
   *
   * An id the deployment does not carry is refused, and the refusal lists what
   * it does carry.
   */
  asset: Resolvable<string | AssetSpec>;
  /**
   * Seconds of life the payer gives the transfer it signs. Default 120. Unlike
   * `maxTimeoutSeconds` this one reaches the ledger, as the transfer's
   * `executeBefore`, and the verifier refuses a transfer already inside its
   * last few seconds. It is the only deadline left in the protocol.
   */
  executeBeforeSeconds?: Resolvable<number>;
  /**
   * Generate (and, if you want, persist) the merchant reference for this
   * challenge — an order or payment id to reconcile against. Called once per
   * challenge ISSUED: on the 402 that offers terms, and not on a request that
   * pays terms already offered. Persisting here is therefore safe — a
   * successful payment mints nothing. Quoting a memo BINDS it: the payer must
   * sign the identical value or verification refuses the payment, which is what
   * makes it usable as a reconciliation key and as a replay key. UTF-8, at most
   * 256 bytes. Omit it to quote none.
   *
   * (Function-only by design: a static value would tag every payment alike,
   * which is the one thing reference data must not do.)
   */
  memo?: (req: Request) => string | Promise<string>;
}

/**
 * `extra`, keyed off the schema's own entries so the table cannot drift from
 * the shape it describes.
 */
const EXTRA_RULES: Record<keyof typeof CantonRequirementsExtraSchema.entries, RuleTable[string]> = {
  // Unreachable today and kept anyway: the schema pins this to a literal, so
  // the requirements guard refuses a wrong value as policy_requirements_invalid
  // before the comparison runs. It is here so that loosening the schema does
  // not silently stop the field being checked.
  assetTransferMethod: { compare: "equal", reason: "policy_transfer_method" },
  // The instrument, not the symbol: `asset` alone cannot say which registry
  // issued it, so comparing symbols would admit a look-alike from another.
  instrumentId: { compare: "equal", reason: "policy_asset" },
  // Echo fidelity only. The payer folds this into the transfer's absolute
  // `executeBefore`, and the verifier checks that deadline is still ahead of
  // now — with no upper bound, so a transfer signed far further out than the
  // quote still verifies. Binding the two is core's to do (#115).
  executeBeforeSeconds: { compare: "equal", reason: "policy_execute_before" },
  // Minted per challenge, and the terms compared against were built without
  // one. Whether the payer echoed a memo the merchant actually issued is a
  // question only the merchant's records answer — hence `preSettle`.
  memo: { compare: "skip", why: "per-challenge; judged by preSettle against merchant records" },
};

/**
 * The default scheme: Canton's registered `exact`.
 *
 * Pass your own {@link SchemeAdapter} to `paymentRequired` to gate a route on
 * something else; nothing in the middleware is canton-shaped.
 */
/**
 * The payload's decoded transfer, decoded at most once.
 *
 * Both `payerOf` and `resourceStampOf` want it, and decoding means gunzipping
 * and walking a protobuf — worth doing once per payment rather than per
 * question. Keyed on the payload object, so nothing outlives the request.
 */
const transfers = new WeakMap<object, ReturnType<typeof decodePayloadTransfer>>();

function transferOf(payload: CantonPaymentPayload) {
  const seen = transfers.get(payload);
  if (seen !== undefined) return seen;
  const decoded = decodePayloadTransfer(payload.payload.preparedTransaction);
  transfers.set(payload, decoded);
  return decoded;
}

export const cantonExact: SchemeAdapter<
  CantonRequirementsSpec,
  CantonPaymentRequirements,
  CantonPaymentPayload
> = {
  id: "exact",

  acceptsRequirements(
    requirements: X402PaymentRequirements<unknown>,
  ): requirements is CantonPaymentRequirements {
    return isCantonPaymentRequirements(requirements);
  },

  acceptsPayload(payload: X402PaymentPayload<unknown>): payload is CantonPaymentPayload {
    return isCantonPaymentPayload(payload);
  },

  // The verifier's own word for a transfer it cannot decode.

  unreadablePayerReason: "invalid_exact_canton_malformed_payload",

  distinctKey(spec: CantonRequirementsSpec): string | undefined {
    // The asset is what makes one way to pay different from another. A
    // resolver cannot be read without a request, so such an entry is skipped.
    const asset = spec.asset;
    if (typeof asset === "function") return undefined;
    return typeof asset === "string" ? asset : asset.instrumentId.id;
  },
  resourceStampOf(payload: CantonPaymentPayload): string | undefined {
    return transferOf(payload)?.resourceUrlStamp;
  },
  payerOf(payload: CantonPaymentPayload): string | undefined {
    // Spec Rule 8: the payer is the signed transfer's sender. It sits inside
    // what was signed, where the dropped `payer` field was a claim beside it.
    return transferOf(payload)?.sender;
  },

  extraRules: EXTRA_RULES,

  async quote(
    req: Request,
    spec: CantonRequirementsSpec,
    ctx: SchemeContext,
  ): Promise<SchemeQuote> {
    const terms = await resolveDeploymentTerms(req, spec, ctx);
    const quote: SchemeQuote = {
      scheme: terms.scheme,
      network: terms.network,
      // The spec's `asset` is only a symbol, so the full `{admin, id}` travels
      // in `extra` where a payer can read which registry issued it.
      asset: terms.asset,
      extra: {
        assetTransferMethod: ASSET_TRANSFER_METHOD,
        instrumentId: terms.instrumentId,
        executeBeforeSeconds:
          spec.executeBeforeSeconds === undefined
            ? DEFAULT_EXECUTE_BEFORE_SECONDS
            : await resolve(spec.executeBeforeSeconds, req),
      },
    };
    const mint = spec.memo;
    if (mint) {
      quote.mintReference = async () => ({ memo: await mint(req) });
      // The generator itself: entries that inherited the merchant's one memo
      // from the shared terms carry the same function, so they share a memo.
      quote.referenceKey = mint;
    }
    return quote;
  },
};

/**
 * The scheme, network and instrument to quote.
 *
 * Anything the merchant pinned is used as given. Anything it left out comes
 * from the facilitator's own `/v2/supported`, so a deployment's registry admin
 * and token are read from the service that will settle the payment rather than
 * copied into the merchant's config and kept in step by hand. The response is
 * cached by the client, so this costs one round trip per TTL, not one per
 * request — and a merchant that pins both fields never calls out at all.
 */
async function resolveDeploymentTerms(
  req: Request,
  spec: CantonRequirementsSpec,
  ctx: SchemeContext,
): Promise<{
  scheme: string;
  network: string;
  asset: string;
  instrumentId: AssetSpec["instrumentId"];
}> {
  const scheme = await resolve(spec.scheme ?? cantonExact.id, req);
  const network = spec.network === undefined ? undefined : await resolve(spec.network, req);
  // A string names the instrument and leaves its admin to discovery; an
  // AssetSpec carries the admin too. Either way the id is known, and is what
  // narrows discovery below.
  const asset = await resolve(spec.asset, req);
  const pinned = typeof asset === "string" ? undefined : asset;
  const instrument = typeof asset === "string" ? asset : asset.instrumentId.id;

  // Both pinned: nothing to discover.
  if (network !== undefined && pinned !== undefined) {
    return {
      scheme,
      network,
      asset: assetSymbol(pinned.instrumentId),
      instrumentId: pinned.instrumentId,
    };
  }

  const prefer: CantonDeploymentPreference = { schemes: [scheme] };
  // Each key is a filter, and an absent one filters on nothing — so add a key
  // only where the merchant named a value. The instrument always narrows: a
  // pinned AssetSpec says which one as surely as a string does, and the
  // network discovered here must be one that settles it.
  if (network !== undefined) prefer.networks = [network];
  prefer.instruments = [instrument];

  const advertised = exactlyOne(
    await selectCantonDeployments(await ctx.facilitator.supported(), prefer),
  );
  return {
    scheme,
    network: network ?? advertised.network,
    asset: pinned ? assetSymbol(pinned.instrumentId) : advertised.asset,
    instrumentId: pinned?.instrumentId ?? advertised.extra.instrumentId,
  };
}

/**
 * The single deployment these terms quote against, or a throw naming the
 * alternatives.
 *
 * Core reports every way a facilitator will settle; one entry carries one
 * price, which is meaningless without knowing which network and instrument it
 * is denominated in. The message names the merchant's own fields, since that
 * is where the fix goes.
 */
function exactlyOne(advertised: CantonDeploymentTerms[]): CantonDeploymentTerms {
  if (advertised.length > 1) {
    throw new Error(
      `paymentRequired: the facilitator settles ${advertised.length} ways to pay (${advertised
        .map((t) => `${t.network} in ${t.extra.instrumentId.id}`)
        .join(", ")}). Set \`network\` on your requirements to pick one, or give each ` +
        `its own \`accepts[]\` entry — each needs its own price.`,
    );
  }
  return advertised[0];
}
