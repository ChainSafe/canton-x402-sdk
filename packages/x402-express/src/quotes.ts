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
    return built.map((r) => ({ requirements: assertAtomicAmount(r) }));
  }

  // The shared terms describe the sale; each entry describes one way to pay for
  // it and may override any of them. Merged before the scheme sees it, so an
  // adapter is handed one complete spec and never has to know the difference.
  const { accepts, ...shared } = source;
  const settled = await Promise.all(
    accepts.map(async (entry) => {
      const spec = { ...shared, ...entry } as unknown as TSpec;
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
 * Turn quotes into a challenge's `accepts[]`, minting each reference.
 *
 * The only caller of a scheme's reference generator, which is what makes "once
 * per challenge" true: a request that pays an existing challenge never reaches
 * here.
 */
export async function issueChallenge<TRequirements extends X402PaymentRequirements<unknown>>(
  quotes: Array<Quote<TRequirements>>,
): Promise<TRequirements[]> {
  return Promise.all(
    quotes.map(async (quote) => {
      if (!quote.mintReference) return quote.requirements;
      const minted = await quote.mintReference();
      return {
        ...quote.requirements,
        extra: { ...(quote.requirements.extra as Record<string, unknown>), ...minted },
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
