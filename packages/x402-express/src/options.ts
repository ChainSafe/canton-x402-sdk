// What a merchant configures, and what it gets back on a paid request.
//
// The shape follows the 402 the spec defines: x402 v2 §5.1.2's `PaymentRequired`
// is ONE resource with a LIST of ways to pay, and `PaymentRequirements` carries
// no resource of its own. So the resource is named once and the ways to pay are
// a list, with no privileged first entry — the merchant's terms, not "the"
// payment plus some extras.
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

/** Seconds a client is given to pay, when the merchant names none. */
export const DEFAULT_MAX_TIMEOUT_SECONDS = 60;

/**
 * One way to pay: a scheme's spec minus the fields named once for all of them.
 *
 * Any shared field may still be set here to override it — a second instrument
 * settling to a different party, say — but nothing has to be repeated.
 */
export type AcceptSpec<TSpec extends BaseRequirementsSpec> = Omit<TSpec, keyof SharedTerms> &
  Partial<SharedTerms>;

/**
 * The merchant's terms: what is being sold, and the ways to pay for it.
 *
 * Fields may be a fixed value or a `(req) => value` resolver.
 */
export interface RequirementsSpec<
  TSpec extends BaseRequirementsSpec = CantonRequirementsSpec,
> extends SharedTerms {
  /**
   * The ways to pay, each advertised as one `accepts[]` entry. A payer picks
   * one; the middleware works out which and holds the payment against it.
   *
   * Each carries its own price, because they are prices in different units —
   * 0.05 of one token is not 0.05 of another, and nothing here checks that two
   * entries are worth the same.
   */
  accepts: Array<AcceptSpec<TSpec>>;
}

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
   * Your own say on a paid request, run after the echoed requirements pass
   * merchant policy and before verify — so before any settle. Return a short
   * reason to refuse it (answered as a `402` carrying that code), or nothing
   * to let it through.
   *
   * This is where merchant state goes, because the middleware has none. It
   * rebuilds the terms on every request, so it can tell you the payer echoed
   * *a* memo, but not whether it is one you issued; it knows the price it
   * quotes now, but not whether that order is still open. Those are questions
   * only your records answer:
   *
   * ```ts
   * checkPayment: async ({ requirements }) => {
   *   const order = await orders.findByRef(requirements.extra.memo);
   *   if (!order) return "policy_memo_unknown";
   *   if (order.status !== "awaiting-payment") return "policy_order_closed";
   * },
   * ```
   */
  checkPayment?: (
    payment: { payload: TPayload; requirements: TRequirements },
    req: Request,
  ) => string | undefined | Promise<string | undefined>;
  /**
   * Called after the middleware rejects a payment it was handed (402), or fails
   * on the facilitator (502) or its own config (500) — e.g. to log it. Not called
   * for the plain 402 challenge to a request without a payment. The middleware
   * logs nothing itself. A throw (or a rejected promise from an async hook) is
   * swallowed so it can't break the response or crash the process.
   */
  onReject?: (rejection: PaymentRejectionInfo, req: Request) => void | Promise<void>;
}

/** What `PaymentRequiredOptions.onReject` receives. */
export interface PaymentRejectionInfo {
  /** HTTP status sent: 402 (payment rejected), 502 (facilitator error), 500 (middleware error). */
  status: 402 | 502 | 500;
  /** The `error` code in the response body (e.g. `bad_signature`, `facilitator_error`). */
  reason: string;
  /** The `details` string in the response body, when there is one. */
  details?: string;
  /** The facilitator's full `extensions` for a verify rejection (may hold more than `details`). */
  extensions?: Record<string, unknown>;
  /** The underlying error, for a 502 or 500. */
  error?: unknown;
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
