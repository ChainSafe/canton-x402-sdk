import type { Request, Response, NextFunction, RequestHandler } from "express";
import {
  CantonPaymentRequirementsSchema,
  decodePaymentHeader,
  isValidAmount,
  type CantonPaymentPayload,
  type CantonPaymentRequirements,
  type SettleResponse,
  type VerifyResponse,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from "@chainsafe/x402-core";
import { FacilitatorError, type FacilitatorClient } from "@chainsafe/x402-client";

import {
  compareQuote,
  resolve,
  type BaseRequirementsSpec,
  type RuleTable,
  type SchemeAdapter,
} from "./scheme.js";
import { cantonExact, type CantonRequirementsSpec } from "./schemes/canton-exact.js";

export type { Resolvable } from "./scheme.js";

/**
 * Declarative requirements: the middleware applies the defaults. Fields may be
 * a fixed value or a per-request resolver.
 *
 * This is the default scheme's spec. A route gated on another scheme uses that
 * scheme's spec instead — see {@link PaymentRequiredOptions.scheme}.
 */
export type RequirementsSpec = CantonRequirementsSpec;

/**
 * Full control: build the entire `PaymentRequirements` per request, `extra`
 * included.
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
> = (req: Request) => TRequirements | Promise<TRequirements>;

/** Configuration for {@link paymentRequired}. */
export interface PaymentRequiredOptions<
  TSpec extends BaseRequirementsSpec = CantonRequirementsSpec,
  TRequirements extends X402PaymentRequirements<unknown> = CantonPaymentRequirements,
  TPayload extends X402PaymentPayload<unknown> = CantonPaymentPayload,
> {
  /** Client used to verify (and optionally settle) payments against the facilitator. */
  facilitator: FacilitatorClient;
  /**
   * The payment scheme this route is gated on. Defaults to Canton's registered
   * `exact` ({@link cantonExact}).
   *
   * It owns `extra` — what the merchant's spec puts in it, how an echoed one is
   * compared, and where a per-challenge reference lives. Everything else here
   * is the protocol's, and applies whatever the scheme.
   */
  scheme?: SchemeAdapter<TSpec, TRequirements, TPayload>;
  /** Capture the payment (call the facilitator's /v2/settle) after a valid verify. Default `false`. */
  settle?: boolean;
  /** How to produce the PaymentRequirements: a declarative spec, or a full builder. */
  requirements: TSpec | RequirementsBuilder<TRequirements>;
  /**
   * Your own say on a paid request, run after the echoed requirements pass
   * merchant policy and before verify — so before any settle. Return a short
   * reason to refuse it (answered as a `402` carrying that code), or nothing
   * to let it through.
   *
   * This is where merchant state goes, because the middleware has none. It
   * rebuilds the quote on every request, so it can tell you the payer echoed
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
   * Extra `accepts[]` entries for the 402 body (e.g. an alternate scheme).
   *
   * A payer may pay any of them: the middleware works out which advertised
   * quote a payment is for and holds it against that one. Like a builder, this
   * runs on every request, so keep it side-effect-free.
   */
  additionalAccepts?: (req: Request) => TRequirements[] | Promise<TRequirements[]>;
  /**
   * Called after the middleware rejects a payment it was handed (402), or fails
   * on the facilitator (502) or its own config (500) — e.g. to log it. Not called
   * for the plain 402 challenge to a request without `X-PAYMENT`. The middleware
   * logs nothing itself. A throw (or a rejected promise from an async hook) is
   * swallowed so it can't break the response or crash the process.
   */
  onReject?: (rejection: PaymentRejectionInfo, req: Request) => void | Promise<void>;
}

/** What {@link PaymentRequiredOptions.onReject} receives. */
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

const DEFAULT_MAX_TIMEOUT_SECONDS = 60;

/**
 * Internal control-flow signal: answer this request with a 402.
 *
 * It carries no requirements. What the 402 advertises is a challenge issued at
 * the point of failure, not something decided when the rejection was raised —
 * see {@link issueChallenge}.
 */
class PaymentRejection extends Error {
  constructor(
    readonly reason: string,
    readonly details?: string,
    readonly extensions?: Record<string, unknown>,
  ) {
    super(reason);
  }
}

/**
 * One quote this request would be offered, before any per-challenge reference
 * has been minted for it.
 *
 * Minting is split out because the generator is the merchant's and is
 * documented to record what it issues: it must run when a challenge is ISSUED,
 * not when a payment is merely held against the terms. Building the two
 * together is what made a successful payment book a second order.
 */
interface Quote<TRequirements> {
  /** The terms themselves — everything except a minted reference. */
  requirements: TRequirements;
  /** Mint the reference, returning the `extra` fields carrying it. */
  mintReference?: () => Promise<Record<string, unknown>>;
}

/**
 * The protocol's common requirement fields, keyed off the one concrete schema
 * that enumerates them.
 *
 * Keyed off a schema rather than written out so a field added to the
 * requirements fails the build here until someone says what comparing it means.
 * The hand-kept list this replaces simply ignored fields nobody remembered to
 * add — which is the quiet way an unchecked field becomes something a payer can
 * set freely. `extra` is the scheme's, and is filled in per adapter.
 */
const COMMON_RULES: Record<keyof typeof CantonPaymentRequirementsSchema.entries, RuleTable[string]> = {
  scheme: { compare: "equal", reason: "policy_scheme" },
  network: { compare: "equal", reason: "policy_network" },
  payTo: { compare: "equal", reason: "policy_payTo" },
  // Bind the payment to THIS resource: without it, a payment minted for path A
  // (matching price/payTo/asset) could be replayed against path B.
  resource: { compare: "equal", reason: "policy_resource" },
  asset: { compare: "equal", reason: "policy_asset" },
  // Overpaying is the payer's business; underpaying is not. Compared as BigInt,
  // because atomic units are 1e10 larger than the token amount — anything over
  // ~900k CC exceeds Number.MAX_SAFE_INTEGER and two prices start comparing
  // equal.
  amount: { compare: "atLeast", reason: "policy_underpriced", invalidReason: "policy_amount_invalid" },
  // Replaced per scheme in rulesFor().
  extra: { compare: "skip", why: "filled in from the scheme adapter" },
  // Neither reaches the ledger, so neither changes what settles. Left
  // uncompared so a payer library that normalises or drops them still pays.
  description: { compare: "skip", why: "informational" },
  maxTimeoutSeconds: { compare: "skip", why: "advisory; nothing refuses a payment for exceeding it" },
};

/** The common rules with this scheme's `extra` rules spliced in. */
function rulesFor(scheme: { extraRules: RuleTable }): RuleTable {
  return { ...COMMON_RULES, extra: { compare: "nested", rules: scheme.extraRules } };
}

/**
 * Express middleware that gates a route behind an x402 payment.
 *
 * Two signatures: the first is the default canton-exact scheme, which keeps the
 * concrete types so an inline requirements object is contextually typed against
 * them. The second is the generic one, for a route gated on another scheme via
 * {@link PaymentRequiredOptions.scheme}.
 *
 * - No/invalid `X-PAYMENT` → `402` with `{ x402Version, accepts: [...] }`.
 * - Valid `X-PAYMENT` → verify (and optionally settle) via the facilitator, then
 *   attach `req.x402` and call `next()`.
 *
 * @example
 * const facilitator = new FacilitatorClient("https://x402.example.com", {
 *   apiKey: process.env.FACILITATOR_API_KEY!,
 * });
 * app.use("/paid", paymentRequired({
 *   facilitator,
 *   settle: true,
 *   requirements: {
 *     payTo: "merchant::1220…",
 *     amount: "500000000", // atomic units — 1 CC = 1e10, so this is 0.05 CC
 *     // `network` and `asset` are read from the facilitator's /v2/supported.
 *   },
 * }));
 */
export function paymentRequired(options: PaymentRequiredOptions): RequestHandler;
export function paymentRequired<
  TSpec extends BaseRequirementsSpec,
  TRequirements extends X402PaymentRequirements<unknown>,
  TPayload extends X402PaymentPayload<unknown>,
>(options: PaymentRequiredOptions<TSpec, TRequirements, TPayload>): RequestHandler;
export function paymentRequired<
  TSpec extends BaseRequirementsSpec = CantonRequirementsSpec,
  TRequirements extends X402PaymentRequirements<unknown> = CantonPaymentRequirements,
  TPayload extends X402PaymentPayload<unknown> = CantonPaymentPayload,
>(options: PaymentRequiredOptions<TSpec, TRequirements, TPayload>): RequestHandler {
  const { facilitator } = options;
  const settle = options.settle ?? false;
  const scheme = (options.scheme ?? cantonExact) as unknown as SchemeAdapter<
    TSpec,
    TRequirements,
    TPayload
  >;
  const rules = rulesFor(scheme);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Built at most once per request, and only when something needs them: a
    // paid request needs terms to hold the payment against, a challenge needs
    // terms to advertise. The failure path reuses whatever was built here.
    let quotes: Array<Quote<TRequirements>> | undefined;
    try {
      const header = req.header("X-PAYMENT");
      // No payment yet. Nothing is built for the terms' own sake — the
      // challenge below is what gets built, references and all.
      if (!header) throw new PaymentRejection("payment_required");

      // The X-PAYMENT envelope carries the requirements the payload was built
      // against; verify against those, after checking them against merchant
      // policy. Nothing in the payload binds them on its own — what binds is
      // the signed transfer the verifier decodes and compares to them.
      let decoded: { payload: X402PaymentPayload<unknown>; requirements: X402PaymentRequirements<unknown> };
      try {
        decoded = decodePaymentHeader(header);
      } catch {
        throw new PaymentRejection("bad_payload");
      }

      // The header is only ENVELOPE-validated on decode, and the envelope is a
      // looseObject: `payload.payload` is `{}` as far as it is concerned, and
      // `extra` is not required at all. decodePaymentHeader types the result
      // optimistically; these guards are the only things that have checked it.
      // Narrow before reading a field, or attacker-controlled input picks our
      // status code by throwing a TypeError into the 500 path.
      if (!scheme.acceptsPayload(decoded.payload)) throw new PaymentRejection("policy_payload_invalid");
      if (!scheme.acceptsRequirements(decoded.requirements)) {
        throw new PaymentRejection("policy_requirements_invalid");
      }
      const payload = decoded.payload;
      const requirements = decoded.requirements;

      quotes = await buildQuotes(req, options, scheme);
      const refusal = selectQuote(requirements, quotes, rules);
      if (refusal !== undefined) throw new PaymentRejection(refusal);

      // The merchant's own checks, on everything the payer sent. Placed here so
      // a refusal costs no verify and, above all, no settle.
      const merchantRefusal = await options.checkPayment?.({ payload, requirements }, req);
      if (merchantRefusal) throw new PaymentRejection(merchantRefusal);

      const verify = await facilitator.verify(payload, requirements);
      if (!verify.isValid) {
        const detail = verify.extensions?.detail;
        throw new PaymentRejection(
          verify.invalidReason ?? "verify_failed",
          typeof detail === "string" ? detail : undefined,
          verify.extensions,
        );
      }

      let settleResponse: SettleResponse | undefined;
      if (settle) {
        settleResponse = await facilitator.settle(payload, requirements);
        if (!settleResponse.success) {
          throw new PaymentRejection(settleResponse.errorReason ?? "settle_failed", settleResponse.errorDetails);
        }
        res.setHeader("X-PAYMENT-RESPONSE", settleResponse.transaction);
      }

      req.x402 = {
        payer: verify.payer ?? payerOf(payload),
        requirements,
        payload,
        verify,
        settle: settleResponse,
      } as X402RequestState;
      next();
    } catch (err) {
      await respondToFailure(err, req, res, options, scheme, quotes);
    }
  };
}

/** The payer the payload names, when the facilitator did not name one. */
function payerOf(payload: X402PaymentPayload<unknown>): string {
  const inner = payload.payload as { payer?: unknown };
  return typeof inner.payer === "string" ? inner.payer : "";
}

/**
 * Send the response for anything thrown above, and tell the merchant about it.
 *
 * A 402 is where the challenge is issued: a refused payer needs terms it can
 * pay, so the quotes are minted here — fresh, with a new reference — rather
 * than echoing back the requirement it just failed on, which a retrying agent
 * would re-send unchanged.
 */
async function respondToFailure<
  TSpec extends BaseRequirementsSpec,
  TRequirements extends X402PaymentRequirements<unknown>,
  TPayload extends X402PaymentPayload<unknown>,
>(
  err: unknown,
  req: Request,
  res: Response,
  options: PaymentRequiredOptions<TSpec, TRequirements, TPayload>,
  scheme: SchemeAdapter<TSpec, TRequirements, TPayload>,
  built: Array<Quote<TRequirements>> | undefined,
): Promise<void> {
  let rejection: PaymentRejectionInfo | undefined;

  if (err instanceof PaymentRejection) {
    try {
      const accepts = await issueChallenge(built ?? (await buildQuotes(req, options, scheme)));
      respond402(res, accepts, err.reason, err.details);
      // A bare challenge (no X-PAYMENT yet) is the normal flow, not a rejection.
      if (err.reason !== "payment_required") {
        rejection = { status: 402, reason: err.reason, details: err.details, extensions: err.extensions };
      }
    } catch (buildErr) {
      // Building the challenge threw — the merchant's config or reference
      // generator, or the facilitator we ask what it settles. There is no quote
      // left to advertise, so this cannot be a 402; it is classified the same
      // way as a throw from the main path, so discovery failing on a bare
      // request reports as the facilitator's fault and not the merchant's.
      rejection = sendNonPaymentError(res, buildErr);
    }
  } else {
    rejection = sendNonPaymentError(res, err);
  }

  if (rejection && options.onReject) {
    // A failing hook must not affect the response, which is already sent.
    const onReject = options.onReject;
    const info = rejection;
    void Promise.resolve()
      .then(() => onReject(info, req))
      .catch(() => {});
  }
}

/**
 * Answer anything that is not a payment rejection: the facilitator's fault
 * (502) or ours/the merchant's (500).
 */
function sendNonPaymentError(res: Response, err: unknown): PaymentRejectionInfo {
  if (err instanceof FacilitatorError) {
    res.status(502).json({ error: "facilitator_error", status: err.status, details: err.message });
    return { status: 502, reason: "facilitator_error", details: err.message, error: err };
  }
  // Misconfiguration (e.g. invalid amount) or an unexpected throw.
  res.status(500).json({ error: "x402_middleware_error", details: errMsg(err) });
  return { status: 500, reason: "x402_middleware_error", details: errMsg(err), error: err };
}

/**
 * Every quote this request would be offered: the merchant's own, then any
 * `additionalAccepts` entries. Never empty.
 *
 * No merchant reference is minted here — see {@link Quote}.
 */
async function buildQuotes<
  TSpec extends BaseRequirementsSpec,
  TRequirements extends X402PaymentRequirements<unknown>,
  TPayload extends X402PaymentPayload<unknown>,
>(
  req: Request,
  options: PaymentRequiredOptions<TSpec, TRequirements, TPayload>,
  scheme: SchemeAdapter<TSpec, TRequirements, TPayload>,
): Promise<Array<Quote<TRequirements>>> {
  const primary = await buildPrimaryQuote(req, options, scheme);
  // Advertised in the same 402, so held to the same rule.
  const additional = options.additionalAccepts
    ? (await options.additionalAccepts(req)).map((r) => ({ requirements: assertAtomicAmount(r) }))
    : [];
  return [primary, ...additional];
}

async function buildPrimaryQuote<
  TSpec extends BaseRequirementsSpec,
  TRequirements extends X402PaymentRequirements<unknown>,
  TPayload extends X402PaymentPayload<unknown>,
>(
  req: Request,
  options: PaymentRequiredOptions<TSpec, TRequirements, TPayload>,
  scheme: SchemeAdapter<TSpec, TRequirements, TPayload>,
): Promise<Quote<TRequirements>> {
  const source = options.requirements;
  // A builder is opaque: it returns finished requirements, so the middleware
  // cannot hold back a reference it may have minted inside. Documented on
  // RequirementsBuilder as the reason it must stay side-effect-free.
  if (typeof source === "function") {
    return { requirements: assertAtomicAmount(await source(req)) };
  }

  const part = await scheme.quote(req, source, { facilitator: options.facilitator });
  const quote: Quote<TRequirements> = {
    requirements: assertAtomicAmount({
      scheme: part.scheme,
      network: part.network,
      amount: await resolve(source.amount, req),
      asset: part.asset,
      extra: part.extra,
      payTo: await resolve(source.payTo, req),
      resource: source.resource ? await resolve(source.resource, req) : absoluteUrl(req),
      description: source.description ? await resolve(source.description, req) : `Access to ${req.path}`,
      maxTimeoutSeconds: source.maxTimeoutSeconds
        ? await resolve(source.maxTimeoutSeconds, req)
        : DEFAULT_MAX_TIMEOUT_SECONDS,
    } as unknown as TRequirements),
  };
  if (part.mintReference) quote.mintReference = part.mintReference;
  return quote;
}

/**
 * Turn quotes into a challenge's `accepts[]`, minting each merchant reference.
 *
 * This is the only caller of a scheme's reference generator, which is what makes
 * "once per challenge" true: a request that pays an existing challenge never
 * reaches here.
 */
async function issueChallenge<TRequirements extends X402PaymentRequirements<unknown>>(
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
 * Which advertised quote is this payment for, if any? Returns the reason to
 * refuse it, or `undefined` when one accepts it.
 *
 * Nothing on the wire names one — there is no quote id in the payload — so the
 * answer is whichever quote the echoed requirement satisfies. That is what lets
 * a merchant advertise more than one: before this, every payment was held
 * against the first quote alone, so paying any `additionalAccepts` entry was
 * refused as if it undercut the price.
 */
function selectQuote<TRequirements extends X402PaymentRequirements<unknown>>(
  echoed: TRequirements,
  quotes: Array<Quote<TRequirements>>,
  rules: RuleTable,
): string | undefined {
  let furthest: { reason: string; depth: number } | undefined;
  for (const quote of quotes) {
    const result = compareQuote(
      echoed as unknown as Record<string, unknown>,
      quote.requirements as unknown as Record<string, unknown>,
      rules,
    );
    if (result.ok) return undefined;
    if (!furthest || result.depth > furthest.depth) {
      furthest = { reason: result.reason, depth: result.depth };
    }
  }
  // buildQuotes never returns an empty list, so `furthest` is always set.
  return furthest?.reason ?? "policy_requirements_invalid";
}

/**
 * Every quote this middleware advertises must carry an atomic amount.
 *
 * Checked here rather than in the declarative branch alone: a builder and
 * `additionalAccepts` produce requirements too, and a decimal from either used
 * to reach the 402 unchecked — then `BigInt(policy.amount)` threw on the paid
 * retry and answered 500. Failing where the requirement is built names the
 * merchant's own config instead.
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

function respond402<TRequirements>(
  res: Response,
  accepts: TRequirements[],
  error: string,
  details: string | undefined,
): void {
  res.status(402).json({
    x402Version: 2,
    accepts,
    error,
    ...(details ? { details } : {}),
  });
}

function absoluteUrl(req: Request): string {
  return `${req.protocol}://${req.get("host") ?? ""}${req.originalUrl}`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
