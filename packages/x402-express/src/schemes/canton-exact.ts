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

import { TermsError } from "../options.js";
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

/**
 * The instrument id a way to pay names.
 *
 * `asset` is required by the spec type, so TypeScript catches a missing one —
 * except from JavaScript, and from a resolver that returns nothing. Said
 * plainly here rather than as a TypeError about `instrumentId` two frames
 * down, and as a {@link TermsError} so it is never skipped as a way to pay
 * that merely failed to quote.
 */
function instrumentIdOf(asset: string | AssetSpec | undefined | null): string {
  if (asset === undefined || asset === null) {
    throw new TermsError(
      "paymentRequired: a way to pay names no `asset`. `amount` is atomic units of " +
        'something, so each entry says what: an instrument id ("Amulet"), or ' +
        "{ instrumentId: { id, admin } } to pin the registry party too.",
    );
  }
  return typeof asset === "string" ? asset : asset.instrumentId.id;
}

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
   * The synchronizer to settle on, as the LOGICAL id
   * `global-domain::1220…`. Read from `GET /v2/supported` when discovery runs,
   * so it is only needed where nothing is discovered — `network` pinned
   * alongside a whole `AssetSpec`.
   */
  synchronizerId?: Resolvable<string>;
  /**
   * The facilitator's own party, quoted as `extra.feePayer`: the relayer that
   * submits the transfer and pays its traffic fee, and the only value the
   * facilitator accepts there (Rule 9). Read from `GET /v2/supported`, and the
   * advertised one always wins, since any other party is refused. So this is
   * only used where nothing is advertised: `network` pinned alongside a whole
   * `AssetSpec`, which reads nothing, or a facilitator that does not advertise
   * one. Left out there, the quote carries no `feePayer`.
   */
  feePayer?: Resolvable<string>;
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
   * Name it ONCE in the shared terms if it books anything. A 402 is one sale
   * however many ways it offers to pay for it, and entries carrying the same
   * function are issued one memo between them — so the same body written out
   * in two entries is two functions, two memos, and two orders booked for a
   * sale that is paid once. An entry naming its own overrides the shared one
   * and gets its own, which is the merchant asking for that.
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
  // The domain the merchant settles on. Compared here so a payer cannot echo
  // another and have the verifier pin the transfer to that instead; the
  // verifier holds the signed transaction to whatever reaches it.
  synchronizerId: { compare: "equal", reason: "policy_synchronizer" },
  // Clients MUST NOT alter it. The facilitator refuses a party that is not its
  // own, but the payer signs nothing that carries this, so an altered or
  // stripped echo is caught here instead of costing a verify call. Absent on
  // both sides, as when the facilitator advertises none, passes.
  feePayer: { compare: "equal", reason: "policy_fee_payer" },
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
    return instrumentIdOf(asset);
  },
  payerOf(payload: CantonPaymentPayload): string | undefined {
    // Spec Rule 8: the payer is the signed transfer's sender. It sits inside
    // what was signed, where the dropped `payer` field was a claim beside it.
    return decodePayloadTransfer(payload.payload.preparedTransaction)?.sender;
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
        synchronizerId: terms.synchronizerId,
        instrumentId: terms.instrumentId,
        // Only when there is one: an undefined key would still be a key, and
        // the payer echoes `extra` whole.
        ...(terms.feePayer === undefined ? {} : { feePayer: terms.feePayer }),
        executeBeforeSeconds:
          spec.executeBeforeSeconds === undefined
            ? DEFAULT_EXECUTE_BEFORE_SECONDS
            : await resolve(spec.executeBeforeSeconds, req),
      },
    };
    const mint = spec.memo;
    if (mint) {
      quote.mintReference = async () => ({ memo: await mint(req) });
      // The generator itself. Entries that inherited the merchant's one memo
      // from the shared terms carry the SAME function, so they are issued one
      // memo between them; an entry naming its own carries another function
      // and gets its own, which is the merchant asking for that.
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
  synchronizerId: string;
  instrumentId: AssetSpec["instrumentId"];
  feePayer?: string;
}> {
  const scheme = await resolve(spec.scheme ?? cantonExact.id, req);
  const network = spec.network === undefined ? undefined : await resolve(spec.network, req);
  // A string names the instrument and leaves its admin to discovery; an
  // AssetSpec carries the admin too. Either way the id is known, and is what
  // narrows discovery below.
  const asset = await resolve(spec.asset, req);
  const instrument = instrumentIdOf(asset);
  const pinned = typeof asset === "string" ? undefined : asset;

  // Both pinned: nothing to discover — so the synchronizer has to come from
  // the merchant, since there is no `/v2/supported` answer to read it from.
  if (network !== undefined && pinned !== undefined) {
    const synchronizerId =
      spec.synchronizerId === undefined ? undefined : await resolve(spec.synchronizerId, req);
    if (synchronizerId === undefined) {
      throw new TermsError(
        "paymentRequired: `network` and a whole `asset` are pinned, so nothing is read from " +
          "/v2/supported — name the `synchronizerId` to settle on, or leave one of them out.",
      );
    }
    return {
      scheme,
      network,
      asset: assetSymbol(pinned.instrumentId),
      synchronizerId,
      instrumentId: pinned.instrumentId,
      feePayer: await merchantFeePayer(req, spec),
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
  // Resolved even when the advertised party wins, so an empty one fails now
  // rather than on the day the facilitator stops advertising.
  const merchantsFeePayer = await merchantFeePayer(req, spec);
  return {
    scheme,
    network: network ?? advertised.network,
    asset: pinned ? assetSymbol(pinned.instrumentId) : advertised.asset,
    // The deployment's own, unless the merchant named one.
    synchronizerId:
      spec.synchronizerId === undefined
        ? advertised.extra.synchronizerId
        : await resolve(spec.synchronizerId, req),
    instrumentId: pinned?.instrumentId ?? advertised.extra.instrumentId,
    // The facilitator's own, whatever the merchant named: Rule 9 refuses any
    // other party. Unlike the synchronizer, which is the merchant's choice.
    feePayer: advertised.extra.feePayer ?? merchantsFeePayer,
  };
}

/**
 * The merchant's `feePayer`, for where the facilitator advertises none. A
 * {@link TermsError} for an empty one, whether or not it is used, since it
 * would name no party and the
 * payer would echo it into a payment the middleware then refuses as malformed.
 */
async function merchantFeePayer(
  req: Request,
  spec: CantonRequirementsSpec,
): Promise<string | undefined> {
  if (spec.feePayer === undefined) return undefined;
  const feePayer = await resolve(spec.feePayer, req);
  if (typeof feePayer !== "string" || feePayer.length === 0) {
    throw new TermsError(
      "paymentRequired: `feePayer` names no party. Give the facilitator's own party id, " +
        "or leave it out.",
    );
  }
  return feePayer;
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
