// Turning a merchant's terms into the quotes a 402 advertises.
//
// Building and issuing are separate: a scheme's per-challenge reference
// generator is the merchant's and may record what it issues, so it runs only
// when a challenge is ISSUED, never when a payment is held against the terms.
//
// SPDX-License-Identifier: Apache-2.0

import type { Request } from "express";
import {
  isValidAmount,
  type ResourceInfo,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from "@chainsafe/x402-core";

import { FacilitatorError } from "@chainsafe/x402-client";

import { resolve, type BaseRequirementsSpec, type SchemeAdapter } from "./scheme.js";
import type { PaymentRequiredOptions } from "./options.js";

/**
 * The merchant's configuration is wrong.
 *
 * Separated from a failure to quote against the facilitator, which is the
 * environment changing and leaves the other ways to pay standing. A merchant
 * error is never skipped: it would drop a way to pay silently and the fix is
 * in the merchant's own hands.
 */
export class TermsError extends Error {
  override readonly name = "TermsError";
}

/** Seconds a client is given to pay, when the merchant names none. */
export const DEFAULT_MAX_TIMEOUT_SECONDS = 60;

/**
 * One way to pay this request would be offered, before any per-challenge
 * reference has been minted for it.
 */
export interface Quote<TRequirements> {
  /** The terms themselves — everything except a minted reference. */
  requirements: TRequirements;
  /** Mint the reference, returning the `extra` fields carrying it. */
  mintReference?: () => Promise<Record<string, unknown>>;
  /** Quotes sharing this (by identity) are issued one reference between them. */
  referenceKey?: unknown;
}

/**
 * What a 402 will say: one resource, and every way to pay for it.
 *
 * The spec's `PaymentRequired` in all but the minted references — §5.1.2 names
 * the resource once and leaves it off `PaymentRequirements`, so it is carried
 * here beside the quotes rather than copied into each of them.
 */
export interface Offer<TRequirements> {
  resource: ResourceInfo;
  quotes: Array<Quote<TRequirements>>;
}

/**
 * Every way to pay this request offers. Never empty.
 *
 * No reference is minted here — see {@link issueChallenge}.
 */
export async function buildQuotes<
  TSpec extends BaseRequirementsSpec,
  TRequirements extends X402PaymentRequirements<unknown>,
  TPayload extends X402PaymentPayload<unknown>,
>(
  req: Request,
  options: PaymentRequiredOptions<TSpec, TRequirements, TPayload>,
  scheme: SchemeAdapter<TSpec, TRequirements, TPayload>,
): Promise<Offer<TRequirements>> {
  const source = options.requirements;

  // A builder is opaque: it returns finished requirements, so the middleware
  // cannot hold back a reference it may have minted inside. Documented on
  // RequirementsBuilder as the reason it must stay side-effect-free.
  if (typeof source === "function") {
    const built = await source(req);
    // A bare array leaves the resource implicit; the object form names it.
    const named = Array.isArray(built) ? { accepts: built } : built;
    if (named.accepts.length === 0) {
      throw new TermsError("paymentRequired: the requirements builder returned no ways to pay");
    }
    if (scheme.checkBuilt) {
      const ctx = { facilitator: options.facilitator };
      for (const r of named.accepts) {
        // Only a requirement the scheme reads as its own; anything else is the
        // builder's business and is refused, as before, when a payer echoes it.
        if (scheme.acceptsRequirements(r)) await scheme.checkBuilt(r, ctx);
      }
    }
    return {
      resource: {
        url: named.resource ?? absoluteUrl(req),
        ...(named.description ? { description: named.description } : {}),
      },
      quotes: named.accepts.map((r) => ({ requirements: assertAtomicAmount(r) })),
    };
  }

  // The shared terms describe the sale; each entry describes one way to pay for
  // it and may override any of them but `resource` and `description`, which name
  // the sale itself. Merged before the scheme sees it, so an adapter is handed
  // one complete spec and never has to know the difference.
  const { accepts, ...shared } = source;
  // The resource is the sale's, named once (x402 v2 §5.1.2).
  const resource = {
    url: shared.resource ? await resolve(shared.resource, req) : absoluteUrl(req),
    description: shared.description
      ? await resolve(shared.description, req)
      : `Access to ${req.path}`,
  };
  const settled = await Promise.allSettled(
    accepts.map(async (entry) => {
      const spec = mergeTerms<TSpec>(shared, entry);
      const part = await scheme.quote(req, spec, { facilitator: options.facilitator });
      const quote: Quote<TRequirements> = {
        requirements: assertAtomicAmount({
          scheme: part.scheme,
          network: part.network,
          amount: await resolve(spec.amount, req),
          asset: part.asset,
          extra: part.extra,
          payTo: await resolve(spec.payTo, req),
          maxTimeoutSeconds: spec.maxTimeoutSeconds
            ? await resolve(spec.maxTimeoutSeconds, req)
            : DEFAULT_MAX_TIMEOUT_SECONDS,
        } as unknown as TRequirements),
      };
      if (part.mintReference) quote.mintReference = part.mintReference;
      if (part.referenceKey !== undefined) quote.referenceKey = part.referenceKey;
      return quote;
    }),
  );

  // The merchant's config is wrong: never skipped, since the fix is theirs.
  const termsError = settled.find(
    (r): r is PromiseRejectedResult => r.status === "rejected" && r.reason instanceof TermsError,
  );
  if (termsError) throw termsError.reason;

  // One way to pay that cannot be quoted does not take the others with it.
  // What is left here is the facilitator's answer, which changes under a
  // running merchant — an instrument is withdrawn, a deployment moves — and
  // refusing every request then loses sales another entry would have taken.
  const quotes = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failed = settled.flatMap((r, i) =>
    r.status === "rejected" ? [{ at: i, error: r.reason as unknown }] : [],
  );

  if (quotes.length === 0) {
    // Nothing left to advertise, so the request cannot be answered. One cause
    // is reported as it came: an ambiguity the merchant must resolve reads
    // better unwrapped than wrapped in a count.
    if (failed.length === 1) throw failed[0].error;
    // The facilitator being down is one cause with several witnesses: answer
    // it as the 502 it is, not wrapped into a 500. `every`, not `some`, so a
    // merchant's own broken entry among them is never buried under a 502.
    if (failed.every((f) => f.error instanceof FacilitatorError)) throw failed[0].error;
    throw new Error(
      `paymentRequired: no way to pay could be quoted — ${failed
        .map((f) => `${f.at + 1}: ${errMsg(f.error)}`)
        .join("; ")}`,
    );
  }
  for (const { at, error } of failed) report(options, req, at, error);
  return { resource, quotes };
}

/** Tell the merchant a way to pay was dropped, without letting that throw. */
function report<
  TSpec extends BaseRequirementsSpec,
  TRequirements extends X402PaymentRequirements<unknown>,
  TPayload extends X402PaymentPayload<unknown>,
>(
  options: PaymentRequiredOptions<TSpec, TRequirements, TPayload>,
  req: Request,
  at: number,
  error: unknown,
): void {
  if (!options.onQuoteError) return;
  const hook = options.onQuoteError;
  void Promise.resolve()
    .then(() => hook(new Error(`way to pay ${at + 1}: ${errMsg(error)}`, { cause: error }), req))
    .catch(() => {});
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}


/**
 * The shared terms with whatever an entry actually names laid over them.
 *
 * Not a spread: `{ ...shared, ...entry }` lets an entry holding an explicit
 * `undefined` — `payTo: someVar` where `someVar` is undefined — erase the
 * shared value, and without `exactOptionalPropertyTypes` the compiler says
 * nothing. Only keys the entry gives a value to override.
 */
function mergeTerms<TSpec>(shared: object, entry: object): TSpec {
  const merged: Record<string, unknown> = { ...shared };
  for (const [key, value] of Object.entries(entry)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as TSpec;
}

/**
 * Turn quotes into a challenge's `accepts[]`, minting each reference.
 *
 * The only caller of a scheme's reference generator, which is what makes "once
 * per challenge" true: a request that pays an existing challenge and is let
 * through never reaches here. A refused one does — a refused payer is handed a
 * fresh challenge, and that is a new challenge with a new reference.
 */
export async function issueChallenge<TRequirements extends X402PaymentRequirements<unknown>>(
  quotes: Array<Quote<TRequirements>>,
): Promise<TRequirements[]> {
  // Quotes sharing a reference generator are issued one reference between
  // them. A generator may book an order, and a 402 is one sale however many
  // ways it offers to pay for it — minting per entry would book N and be paid
  // for one, with nothing in the generator's arguments to tell them apart.
  const shared = new Map<unknown, Promise<Record<string, unknown>>>();
  return Promise.all(
    quotes.map(async (quote) => {
      const mint = quote.mintReference;
      if (!mint) return quote.requirements;
      const key = quote.referenceKey;
      let minted: Promise<Record<string, unknown>>;
      if (key === undefined) {
        minted = mint();
      } else {
        minted = shared.get(key) ?? mint();
        shared.set(key, minted);
      }
      return {
        ...quote.requirements,
        extra: { ...(quote.requirements.extra as Record<string, unknown>), ...(await minted) },
      };
    }),
  );
}

/**
 * Every quote this middleware advertises must carry an atomic amount.
 *
 * Checked where the requirement is built, so a decimal names the merchant's own
 * config rather than reaching the 402 unchecked and then throwing inside
 * `BigInt(...)` on the paid retry, which answered 500.
 */
function assertAtomicAmount<TRequirements extends X402PaymentRequirements<unknown>>(
  r: TRequirements,
): TRequirements {
  if (!isValidAmount(r.amount)) {
    throw new TermsError(
      `paymentRequired: amount "${r.amount}" is not an integer string of atomic units`,
    );
  }
  return r;
}

/**
 * The URL a request was made to: the `resource` an offer defaults to when the
 * terms name none. Resolved once here, since the 402 names the resource once.
 */
function absoluteUrl(req: Request): string {
  return `${req.protocol}://${req.get("host") ?? ""}${req.originalUrl}`;
}

/**
 * Throws when the terms cannot produce a 402.
 *
 * Both checks are on what the merchant wrote, so both run once, when the route
 * is mounted — a request cannot change either answer, and answering 500 to
 * every request for a config mistake hides it.
 *
 * - `accepts` must offer something: a 402 with no way to pay cannot be paid.
 * - No two entries may be the same way to pay. A payer chooses by what an
 *   entry says, and the asset is what says it, so two in one asset leave only
 *   price to choose on and the dearer can never be paid. The scheme reads each
 *   entry's key ({@link SchemeAdapter.distinctKey}); an entry whose asset is a
 *   resolver has none and is not checked.
 *
 * A builder is skipped entirely: it answers per request.
 */
export function assertUsableTerms<
  TSpec extends BaseRequirementsSpec,
  TRequirements extends X402PaymentRequirements<unknown>,
  TPayload extends X402PaymentPayload<unknown>,
>(
  source: PaymentRequiredOptions<TSpec, TRequirements, TPayload>["requirements"],
  scheme: SchemeAdapter<TSpec, TRequirements, TPayload>,
): void {
  if (typeof source === "function") return;
  const { accepts, ...shared } = source;
  if (accepts.length === 0) {
    throw new TermsError("paymentRequired: `accepts` is empty — a 402 must advertise a way to pay");
  }
  const seen = new Map<string, number>();
  accepts.forEach((entry, i) => {
    const key = scheme.distinctKey?.({ ...shared, ...entry } as unknown as TSpec);
    if (key === undefined) return;
    const first = seen.get(key);
    if (first !== undefined) {
      throw new TermsError(
        `paymentRequired: ways to pay ${first + 1} and ${i + 1} are both in ${key}. ` +
          `A payer cannot tell them apart, so only the cheaper would ever be paid — ` +
          `give them different assets, or quote one.`,
      );
    }
    seen.set(key, i);
  });
}
