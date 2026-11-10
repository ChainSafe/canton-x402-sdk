// The canton-exact scheme, as the middleware sees it.
//
// Everything canton-specific that used to be spelled out in the middleware
// lives here: the shape of `extra`, how an echoed one is compared, where the
// merchant's reference sits inside it, and how the deployment's own terms are
// read from the facilitator.
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
   * Asset to charge in.
   *
   * Omit it to charge in what the facilitator says it settles: the instrument
   * — the registry admin included — is read from `GET /v2/supported`. That is
   * the party the facilitator validates the payer's holding against, so taking
   * it from there means there is no second copy to keep true. Set it to pin the
   * instrument yourself and skip the lookup.
   */
  asset?: Resolvable<AssetSpec>;
  /**
   * Which instrument to charge in when the facilitator settles several and
   * `asset` is omitted — the instrument's `id`, e.g. `"Amulet"`. Without it, a
   * facilitator advertising more than one is an error rather than a guess.
   */
  instrument?: Resolvable<string>;
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
  // Reaches the ledger as the transfer's executeBefore, so a payer echoing its
  // own value would be choosing how long the merchant's quote stays settleable.
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
        instrumentId: terms.instrumentId,
        executeBeforeSeconds:
          spec.executeBeforeSeconds === undefined
            ? DEFAULT_EXECUTE_BEFORE_SECONDS
            : await resolve(spec.executeBeforeSeconds, req),
      },
    };
    const mint = spec.memo;
    if (mint) quote.mintReference = async () => ({ memo: await mint(req) });
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
  const pinned = spec.asset === undefined ? undefined : await resolve(spec.asset, req);

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
  if (network !== undefined) prefer.networks = [network];
  const instrument =
    spec.instrument === undefined ? undefined : await resolve(spec.instrument, req);
  if (instrument !== undefined) prefer.instruments = [instrument];

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
 * One quote needs one set of terms.
 *
 * Core reports every way a facilitator will settle, because a 402 may advertise
 * several — but a declarative spec carries ONE price, and a price means nothing
 * without the instrument it is denominated in. So quoting from a facilitator
 * that settles two instruments, without saying which, is a question the merchant
 * has not answered yet; answering it by taking the first would quote 0.05 of
 * whichever token happened to be advertised first.
 *
 * Worded for the merchant, naming the fields it actually writes, because the
 * fix is in its own config and not in the facilitator's response.
 */
function exactlyOne(advertised: CantonDeploymentTerms[]): CantonDeploymentTerms {
  if (advertised.length > 1) {
    throw new Error(
      `paymentRequired: the facilitator settles ${advertised.length} ways to pay (${advertised
        .map((t) => `${t.network} in ${t.extra.instrumentId.id}`)
        .join(", ")}). Set \`network\` and/or \`instrument\` on your requirements to pick one, ` +
        `or give each its own entry via \`additionalAccepts\` — each needs its own price.`,
    );
  }
  return advertised[0];
}
