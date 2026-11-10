// Turning a merchant's terms into the quotes a 402 advertises.
//
// Building and issuing are separate on purpose: a scheme's per-challenge
// reference generator is the merchant's, and is documented to record what it
// issues. It must run when a challenge is ISSUED, not when a payment is merely
// held against the terms — doing both at once is what made a successful payment
// book a second order.
//
// SPDX-License-Identifier: Apache-2.0

import type { Request } from "express";
import {
  isValidAmount,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from "@chainsafe/x402-core";

import { resolve, type BaseRequirementsSpec, type SchemeAdapter } from "./scheme.js";
import { DEFAULT_MAX_TIMEOUT_SECONDS, type PaymentRequiredOptions } from "./options.js";

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
      throw new Error("paymentRequired: the requirements builder returned no ways to pay");
    }
    return built.map((r) => ({ requirements: assertAtomicAmount(r) }));
  }

  if (source.accepts.length === 0) {
    throw new Error("paymentRequired: `accepts` is empty — a 402 must advertise a way to pay");
  }

  // The shared terms describe the sale; each entry describes one way to pay for
  // it and may override any of them. Merged before the scheme sees it, so an
  // adapter is handed one complete spec and never has to know the difference.
  const { accepts, ...shared } = source;
  return Promise.all(
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
    }),
  );
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
    throw new Error(
      `paymentRequired: amount "${r.amount}" is not an integer string of atomic units`,
    );
  }
  return r;
}

function absoluteUrl(req: Request): string {
  return `${req.protocol}://${req.get("host") ?? ""}${req.originalUrl}`;
}
