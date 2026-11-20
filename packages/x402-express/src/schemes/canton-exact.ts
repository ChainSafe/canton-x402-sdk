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
  CantonRequirementsExtraKey,
  decodePayloadTransfer,
  isCantonPaymentPayload,
  isCantonPaymentRequirements,
  selectCantonDeployments,
  type CantonPaymentPayload,
  type CantonPaymentRequirements,
  type CantonDeploymentPreference,
  type CantonDeploymentTerms,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from "@chainsafe/x402-core";

import { sameValue, type RuleTable } from "../policy.js";
import { TermsError } from "../quotes.js";
import {
  resolve,
  type BaseRequirementsSpec,
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
 * plainly here, and as a {@link TermsError} so it is never skipped as a way to
 * pay that merely failed to quote.
 */
function instrumentIdOf(asset: unknown): string {
  if (typeof asset === "string" && asset.length > 0) return asset;
  throw new TermsError(
    typeof asset === "object" && asset !== null
      ? // The form this field took before 2.0, so a merchant upgrading meets it.
        'paymentRequired: `asset` is an instrument id string ("Amulet", "USDCx"). The ' +
          "{ instrumentId: { id, admin } } form is gone: the registry admin is read from the " +
          "facilitator's /v2/supported."
      : "paymentRequired: a way to pay names no `asset`. `amount` is atomic units of " +
          'something, so each entry names the instrument id it is priced in ("Amulet", "USDCx").',
  );
}

/** Declarative requirements for canton-exact. */
export interface CantonRequirementsSpec extends BaseRequirementsSpec {
  /**
   * The instrument id this way to pay is priced in. Required, since `amount`
   * is atomic units of whatever this names.
   *
   * ```ts
   * asset: "Amulet"   // Canton Coin. NOT "CC" — that is the wire SYMBOL, and
   *                   // Amulet is the one instrument whose id differs from it.
   * asset: "USDCx"    // id and symbol match here
   * ```
   *
   * Only the id. The registry `admin`, the synchronizer and the relaying
   * `feePayer` are the facilitator's own facts, so they are always read from
   * its `GET /v2/supported` and cannot be configured here: a wrong one would
   * only surface at verify, after the payer had signed. An id the facilitator
   * does not advertise is refused, and the refusal lists what it does.
   */
  asset: Resolvable<string>;
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
const EXTRA_RULES: Record<CantonRequirementsExtraKey, RuleTable[string]> = {
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
  // Not `equal`: that asks "is this what I quoted?", and a 402 issued before a
  // party rotation echoes the old one — which the facilitator still answers to
  // and would accept. Nothing is lost by leaving it, since a payer can only
  // name a party the facilitator answers to.
  feePayer: { compare: "skip", why: "the facilitator's own; it judges the value against the parties it answers to" },
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
    const scheme = await resolve(spec.scheme ?? cantonExact.id, req);
    const network = spec.network === undefined ? undefined : await resolve(spec.network, req);
    const deployment = await deploymentFor(ctx, {
      scheme,
      network,
      instrument: instrumentIdOf(await resolve(spec.asset, req)),
    });
    const quote: SchemeQuote = {
      scheme,
      network: deployment.network,
      // The spec's `asset` is only a symbol, so the full `{admin, id}` travels
      // in `extra` where a payer can read which registry issued it.
      asset: deployment.asset,
      extra: {
        assetTransferMethod: ASSET_TRANSFER_METHOD,
        ...facilitatorTerms(deployment),
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

  async checkBuilt(requirements: CantonPaymentRequirements, ctx: SchemeContext): Promise<void> {
    // A builder writes the whole of `extra`, so it can name values that are
    // the facilitator's to state. Held against what the facilitator
    // advertises, so a wrong one is refused here rather than at verify.
    const deployment = await deploymentFor(ctx, {
      scheme: requirements.scheme,
      network: requirements.network,
      instrument: requirements.extra.instrumentId.id,
    });
    const advertised = facilitatorTerms(deployment);
    for (const field of FACILITATOR_TERMS) {
      if (!sameValue(requirements.extra[field], advertised[field])) {
        throw new TermsError(
          `paymentRequired: the requirements builder quotes extra.${field} ` +
            `${JSON.stringify(requirements.extra[field])}, but the facilitator advertises ` +
            `${JSON.stringify(advertised[field])} on /v2/supported. It is the facilitator's ` +
            "own fact; quote what it advertises.",
        );
      }
    }
  },
};

/** The `extra` fields only the facilitator can state. */
const FACILITATOR_TERMS = ["instrumentId", "synchronizerId", "feePayer"] as const;

/**
 * The facilitator's own part of `extra`, read from its advertised deployment:
 * the instrument with its registry admin, the synchronizer it submits to, and
 * the party that relays the transfer.
 */
function facilitatorTerms(
  deployment: CantonDeploymentTerms,
): Pick<CantonPaymentRequirements["extra"], (typeof FACILITATOR_TERMS)[number]> {
  const { instrumentId, synchronizerId, feePayer } = deployment.extra;
  // Advertised only once the facilitator has a party configured. Without one
  // there is nobody to relay the payment, so it cannot be quoted. The fix is
  // the facilitator's, which is why this is not a TermsError: the way to pay
  // is dropped and reported, and the route's other ways to pay still quote.
  if (feePayer === undefined) {
    throw new Error(
      `paymentRequired: the facilitator advertises no feePayer for ${deployment.network} ` +
        "on /v2/supported, so nothing can relay this payment. It has no party configured yet.",
    );
  }
  return { instrumentId, synchronizerId, feePayer };
}

/**
 * The one deployment to quote against, from the facilitator's `/v2/supported`.
 *
 * `scheme` and `instrument` always narrow; `network` narrows when the merchant
 * named one. The response is cached by the client, so this costs one round
 * trip per TTL, not one per request.
 */
async function deploymentFor(
  ctx: SchemeContext,
  want: { scheme: string; network: string | undefined; instrument: string },
): Promise<CantonDeploymentTerms> {
  const prefer: CantonDeploymentPreference = {
    schemes: [want.scheme],
    instruments: [want.instrument],
  };
  if (want.network !== undefined) prefer.networks = [want.network];
  return exactlyOne(await selectCantonDeployments(await ctx.facilitator.supported(), prefer));
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
