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
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from "@chainsafe/x402-core";

import { FacilitatorError } from "@chainsafe/x402-client";

import { resolve, type BaseRequirementsSpec, type SchemeAdapter } from "./scheme.js";
import {
  DEFAULT_MAX_TIMEOUT_SECONDS,
  TermsError,
  type PaymentRequiredOptions,
} from "./options.js";

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
): Promise<Array<Quote<TRequirements>>> {
  const source = options.requirements;

  // A builder is opaque: it returns finished requirements, so the middleware
  // cannot hold back a reference it may have minted inside. Documented on
  // RequirementsBuilder as the reason it must stay side-effect-free.
  if (typeof source === "function") {
    const built = await source(req);
    if (built.length === 0) {
      throw new TermsError("paymentRequired: the requirements builder returned no ways to pay");
    }
    // A 402 names ONE resource. The declarative form cannot disagree — entries
    // do not override it — but a builder returns finished requirements, so it
    // can, and the envelope would quietly take the first.
    const resources = new Set(built.map((r) => r.resource));
    if (resources.size > 1) {
      throw new TermsError(
        `paymentRequired: the requirements builder returned ${resources.size} different resources ` +
          `(${[...resources].map((r) => r ?? "none").join(", ")}). A 402 names one.`,
      );
    }
    return built.map((r) => ({ requirements: assertAtomicAmount(r) }));
  }

  // The shared terms describe the sale; each entry describes one way to pay for
  // it and may override any of them but `resource` and `description`, which name
  // the sale itself. Merged before the scheme sees it, so an adapter is handed
  // one complete spec and never has to know the difference.
  const { accepts, ...shared } = source;
  const settled = await Promise.all(
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
          resource: spec.resource ? await resolve(spec.resource, req) : absoluteUrl(req),
          description: spec.description
            ? await resolve(spec.description, req)
            : `Access to ${req.path}`,
          maxTimeoutSeconds: spec.maxTimeoutSeconds
            ? await resolve(spec.maxTimeoutSeconds, req)
            : DEFAULT_MAX_TIMEOUT_SECONDS,
        } as unknown as TRequirements),
      };
      if (part.mintReference) quote.mintReference = part.mintReference;
      if (part.referenceKey !== undefined) quote.referenceKey = part.referenceKey;
      return quote;
    }).map((quote) => quote.then(
      (value) => ({ value }),
      (error: unknown) => {
        if (error instanceof TermsError) throw error;
        return { error };
      },
    )),
  );

  // One way to pay that cannot be quoted does not take the others with it — a
  // TermsError already threw above, so what is left here is the facilitator's
  // answer, not the merchant's config. The
  // facilitator's answer changes under a running merchant — an instrument is
  // withdrawn, a deployment moves — and refusing every request then, paid ones
  // included, loses sales that another entry would have taken.
  const quotes = settled.flatMap((r) => ("value" in r ? [r.value] : []));
  const failed = settled.flatMap((r, i) => ("error" in r ? [{ at: i, error: r.error }] : []));

  if (quotes.length === 0) {
    // Nothing left to advertise, so the request cannot be answered. One cause
    // is reported as it came: an ambiguity the merchant must resolve reads
    // better unwrapped than wrapped in a count.
    if (failed.length === 1) throw failed[0].error;
    // The facilitator being down is ONE cause with several witnesses, not
    // several causes. Wrapping it loses what it is, and the middleware answers
    // `500 x402_middleware_error` — our fault, nothing to retry — for an
    // outage that a route offering one way to pay answers `502` for. The
    // number of ways a merchant takes money must not decide what a client is
    // told about someone else's downtime.
    //
    // `every`, not `some`: today the entries share one `/v2/supported` call,
    // so either all of them failed on it or none did and a mixed set cannot
    // arise. If a per-entry call to the facilitator ever appears, `some` would
    // answer 502 for a set that also holds a merchant's own broken entry and
    // bury it.
    if (failed.every((f) => f.error instanceof FacilitatorError)) throw failed[0].error;
    throw new Error(
      `paymentRequired: no way to pay could be quoted — ${failed
        .map((f) => `${f.at + 1}: ${errMsg(f.error)}`)
        .join("; ")}`,
    );
  }
  for (const { at, error } of failed) report(options, req, at, error);
  return quotes;
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
 * per challenge" true: a request that pays an existing challenge never reaches
 * here.
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
 * The URL a request was made to, which is the `resource` a quote defaults to.
 *
 * Exported because response.ts needs the SAME value: a 402's top-level
 * `resource` falls back to it when the terms name none, and the two falling
 * back differently would have the envelope disagree with its own `accepts[]`.
 */
export function absoluteUrl(req: Request): string {
  return `${req.protocol}://${req.get("host") ?? ""}${req.originalUrl}`;
}
