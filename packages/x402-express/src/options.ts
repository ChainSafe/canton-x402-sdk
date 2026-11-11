// What a merchant configures, and what it gets back on a paid request.
//
// The shape follows x402 v2 §5.1.2's `PaymentRequired`: ONE resource and a
// LIST of ways to pay. So the resource is named once and the entries are a
// list, with no privileged first entry.
//
// SPDX-License-Identifier: Apache-2.0

import type { Request } from "express";
import type {
  CantonPaymentPayload,
  CantonPaymentRequirements,
  SettleResponse,
  VerifyResponse,
  X402PaymentPayload,
  X402PaymentRequirements,
} from "@chainsafe/x402-core";
import type { FacilitatorClient } from "@chainsafe/x402-client";

import type { BaseRequirementsSpec, Resolvable, SchemeAdapter, SharedTerms } from "./scheme.js";
import type { CantonRequirementsSpec } from "./schemes/canton-exact.js";

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
 * One way to pay: a scheme's spec minus the fields named once for all of them.
 *
 * Most shared fields may still be set here to override them — a second
 * instrument settling to a different party, say — but nothing has to be
 * repeated. `resource` and `description` are not among them: a 402 names ONE
 * resource (x402 v2 §5.1.2), so entries disagreeing about it would make the
 * envelope describe one sale and its entries another.
 */
export type AcceptSpec<TSpec extends BaseRequirementsSpec> = Omit<TSpec, keyof SharedTerms> &
  Partial<Omit<SharedTerms, "resource" | "description">>;

/**
 * The merchant's terms: what is being sold, and the ways to pay for it.
 *
 * The mirror of {@link AcceptSpec}: an entry must carry the scheme's own
 * fields and may override the shared ones, so the terms carry the shared ones
 * and may name any of the scheme's once for the whole sale.
 *
 * That last part is what `memo` needs. Entries are issued ONE reference
 * between them when they carry the same generator, and naming it here hands
 * every entry that one function without repeating it — written out in two
 * entries it is two functions, so two references, and a generator that books
 * an order books two. (Hoisting it into a variable and naming that in each
 * entry works too; this spares the repetition.)
 * A field named here that every entry restates anyway, `amount`, is simply
 * overridden.
 *
 * Fields may be a fixed value or a `(req) => value` resolver.
 */
export type RequirementsSpec<TSpec extends BaseRequirementsSpec = CantonRequirementsSpec> =
  SharedTerms &
    Partial<Omit<TSpec, keyof SharedTerms>> & {
      /**
       * The ways to pay, each advertised as one `accepts[]` entry. A payer
       * picks one and echoes it back as the payment's `accepted`; the
       * middleware holds that against every entry this request would
       * advertise, and lets it through if any of them takes it. Nothing on the
       * wire says which one it was for.
       *
       * Each carries its own price, because they are prices in different units
       * — 0.05 of one token is not 0.05 of another, and nothing here checks
       * that two entries are worth the same.
       */
      accepts: Array<AcceptSpec<TSpec>>;
    };

/**
 * Full control: build the whole `accepts[]` per request.
 *
 * Called on EVERY request, paid ones included — a payment has to be held
 * against the merchant's terms, and a builder is the only thing that knows
 * them. So it must be side-effect-free: recording an order from in here books
 * one per request rather than one per challenge. Use the scheme spec's
 * per-challenge reference hook (canton-exact: `memo`) for anything that should
 * happen once per challenge; the middleware calls that only when it issues one.
 */
export type RequirementsBuilder<
  TRequirements extends X402PaymentRequirements<unknown> = CantonPaymentRequirements,
> = (req: Request) => TRequirements[] | Promise<TRequirements[]>;

/** Configuration for `paymentRequired`. */
export interface PaymentRequiredOptions<
  TSpec extends BaseRequirementsSpec = CantonRequirementsSpec,
  TRequirements extends X402PaymentRequirements<unknown> = CantonPaymentRequirements,
  TPayload extends X402PaymentPayload<unknown> = CantonPaymentPayload,
> {
  /** Client used to verify (and optionally settle) payments against the facilitator. */
  facilitator: FacilitatorClient;
  /**
   * The payment scheme this route is gated on. Defaults to Canton's registered
   * `exact` (`cantonExact`).
   *
   * It owns `extra` — what a spec puts in it, how an echoed one is compared,
   * where a per-challenge reference lives, and how to read the payer. Everything
   * else here is the protocol's, and applies whatever the scheme.
   */
  scheme?: SchemeAdapter<TSpec, TRequirements, TPayload>;
  /** Capture the payment (call the facilitator's /v2/settle) after a valid verify. Default `false`. */
  settle?: boolean;
  /** The terms to advertise: a declarative spec, or a builder for the whole list. */
  requirements: RequirementsSpec<TSpec> | RequirementsBuilder<TRequirements>;
  /**
   * Your own say on a verified payment, run after the facilitator has verified
   * it and before anything settles. Return a short reason to refuse it
   * (answered as a `402` carrying that code), or nothing to let it through.
   *
   * This is where merchant state goes, because the middleware has none. It
   * rebuilds the terms on every request, so it can tell you the payer echoed
   * *a* memo, but not whether it is one you issued; it knows the price it
   * quotes now, but not whether that order is still open. Those are questions
   * only your records answer:
   *
   * ```ts
   * preSettle: async ({ requirements, payer }) => {
   *   const order = await orders.findByRef(requirements.extra.memo);
   *   if (!order) return "policy_memo_unknown";
   *   if (order.status !== "awaiting-payment") return "policy_order_closed";
   *   if (order.buyer !== payer) return "policy_wrong_payer";
   * },
   * ```
   *
   * Running after verify means `requirements` has been held against the signed
   * transfer, so a memo here is one the payer committed to rather than one it
   * claims — safe to reserve stock or mark an order claimed on. `payer` is the
   * verified transfer's sender, and is unavailable before this point: the
   * payload names none (spec Rule 8).
   *
   * With `settle: false` nothing settles, and this is the last gate before the
   * request is let through.
   */
  preSettle?: (
    payment: {
      payload: TPayload;
      requirements: TRequirements;
      /** The verified transfer's sender. */
      payer: string;
      verify: VerifyResponse;
    },
    req: Request,
  ) => string | undefined | Promise<string | undefined>;
  /**
   * Called after the middleware rejects a payment it was handed (402), or fails
   * on the facilitator (502) or its own config (500) — e.g. to log it. Not called
   * for the plain 402 challenge to a request without a payment. The middleware
   * logs nothing itself. A throw (or a rejected promise from an async hook) is
   * swallowed so it can't break the response or crash the process.
   */
  onReject?: (
    rejection: PaymentRejectionInfo<TRequirements, TPayload>,
    req: Request,
  ) => void | Promise<void>;
  /**
   * Called when a way to pay could not be quoted and was left out of the 402,
   * e.g. the facilitator no longer settles the instrument it names. The
   * request is still answered, from the entries that did quote.
   *
   * Nothing else reports this: the 402 simply has fewer entries, so without a
   * hook a way to pay can disappear unnoticed. Fires once per dropped entry
   * per request, so throttle if you log it. A throw (or a rejected promise) is
   * swallowed, as with {@link PaymentRequiredOptions.onReject}.
   *
   * Not called when NO entry can be quoted — there is nothing to answer with
   * then, and the request fails instead: `502` when the facilitator is what
   * failed, whatever the number of entries, and `500` when the cause is the
   * merchant's own config.
   */
  onQuoteError?: (error: Error, req: Request) => void | Promise<void>;
}

/** What `PaymentRequiredOptions.onReject` receives. */
export interface PaymentRejectionInfo<
  TRequirements extends X402PaymentRequirements<unknown> = CantonPaymentRequirements,
  TPayload extends X402PaymentPayload<unknown> = CantonPaymentPayload,
> {
  /** HTTP status sent: 402 (payment rejected), 502 (facilitator error), 500 (middleware error). */
  status: 402 | 502 | 500;
  /** The `error` code in the response body (e.g. `invalid_exact_canton_signature_invalid`, `facilitator_error`). */
  reason: string;
  /** The `details` string in the response body, when there is one. */
  details?: string;
  /**
   * For a verify rejection, the facilitator's full `extensions` (may hold more
   * than `details`, and `reason` holds the code it answered with before the
   * spec's). The middleware's own refusal of a transfer it cannot decode sets
   * one in the same shape.
   */
  extensions?: Record<string, unknown>;
  /** The underlying error, for a 502 or 500. */
  error?: unknown;
  /**
   * The payment this refusal is about — present exactly when an undo may be
   * owed, which is once {@link PaymentRequiredOptions.preSettle} has ACCEPTED
   * it. So: a settle that failed or threw, and anything that goes wrong after.
   * Absent for every refusal before that point, `preSettle`'s own included.
   *
   * It is what lets a merchant undo work `preSettle` did — releasing stock it
   * reserved, reopening an order it marked claimed. `requirements.extra`
   * carries whatever reference the merchant quoted, and it is one the payer
   * signed: verify has held these requirements against the transfer.
   *
   * Not attached earlier on purpose. Before verify the requirements are
   * whatever the header claimed, so an underpriced payment echoing another
   * order's reference would name that order here and a merchant releasing it
   * would release someone else's.
   *
   * One thing it cannot tell you: a `502` from a settle that threw may still
   * have gone through on the ledger, the answer having been lost rather than
   * the payment. Undoing on that one is a decision about which way to be
   * wrong, not a certainty.
   */
  payment?: {
    payload: TPayload;
    /** The `accepts[]` entry the payer chose, as `preSettle` received it. */
    requirements: TRequirements;
    /** The verified transfer's sender, as `preSettle` received it. */
    payer: string;
  };
}

/**
 * What a verified payment leaves on the request.
 *
 * Type-parameterised so a route gated on another scheme can say what its
 * `requirements` and `payload` are; the Express global below pins the default
 * scheme's shapes, which is what `req.x402` is typed as.
 */
export interface X402RequestState<
  TRequirements = CantonPaymentRequirements,
  TPayload = CantonPaymentPayload,
> {
  payer: string;
  requirements: TRequirements;
  payload: TPayload;
  verify: VerifyResponse;
  settle?: SettleResponse;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      x402?: X402RequestState;
    }
  }
}

/** Re-exported so a merchant writing a spec does not need two imports. */
export type { Resolvable };

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
