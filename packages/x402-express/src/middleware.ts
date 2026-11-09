import type { Request, Response, NextFunction, RequestHandler } from "express";
import {
  ASSET_TRANSFER_METHOD,
  assetSymbol,
  decodePayloadTransfer,
  isCantonPaymentRequirements,
  isValidAmount,
  decodePaymentHeader,
  type AssetSpec,
  type CantonPaymentPayload,
  type CantonPaymentRequirements,
  type SettleResponse,
  type VerifyResponse,
} from "@chainsafe/x402-core";
import { FacilitatorError, type FacilitatorClient } from "@chainsafe/x402-client";

/** A fixed value, or one computed per request. */
export type Resolvable<T> = T | ((req: Request) => T | Promise<T>);

/**
 * Declarative requirements: the middleware applies the defaults. Fields may be a
 * fixed value or a per-request resolver.
 */
export interface RequirementsSpec {
  /** Merchant party receiving payment. */
  payTo: Resolvable<string>;
  /** Asset to charge in. */
  asset: Resolvable<AssetSpec>;
  /** Network id — on Canton a `canton:<name>` from x402-core's networks. */
  network: Resolvable<string>;
  /**
   * Price in **atomic units**, as an integer string: 1 CC = 1e10, so
   * `"500000000"` is 0.05 CC. The same unit the wire carries — the middleware
   * does not convert, so a quote means the same thing here as in a
   * {@link RequirementsBuilder} or in an echoed requirement.
   */
  amount: Resolvable<string>;
  /** Scheme id. Default `exact`. */
  scheme?: Resolvable<string>;
  /** Resource URL. Default: the request's absolute URL. */
  resource?: Resolvable<string>;
  /** Human description. Default: `Access to <path>`. */
  description?: Resolvable<string>;
  /**
   * Seconds the client has to complete payment. Default 60. Advisory: nothing
   * refuses a payment for exceeding it.
   */
  maxTimeoutSeconds?: Resolvable<number>;
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
   * challenge, so it SHOULD return a value that identifies this one. Quoting a
   * memo BINDS it: the payer must sign the identical value or verification
   * refuses the payment, which is what makes it usable as a reconciliation key
   * and as a replay key. UTF-8, at most 256 bytes. Omit it to quote none.
   *
   * (Function-only by design: a static value would tag every payment alike,
   * which is the one thing reference data must not do.)
   */
  memo?: (req: Request) => string | Promise<string>;
}

/**
 * Full control: build the entire `PaymentRequirements` per request, `extra`
 * included.
 */
export type RequirementsBuilder = (
  req: Request,
) => CantonPaymentRequirements | Promise<CantonPaymentRequirements>;

/** Configuration for {@link paymentRequired}. */
export interface PaymentRequiredOptions {
  /** Client used to verify (and optionally settle) payments against the facilitator. */
  facilitator: FacilitatorClient;
  /** Capture the payment (call the facilitator's /v2/settle) after a valid verify. Default `false`. */
  settle?: boolean;
  /** How to produce the PaymentRequirements: a declarative spec, or a full builder. */
  requirements: RequirementsSpec | RequirementsBuilder;
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
    payment: { payload: CantonPaymentPayload; requirements: CantonPaymentRequirements },
    req: Request,
  ) => string | undefined | Promise<string | undefined>;
  /** Extra `accepts[]` entries for the 402 body (e.g. an alternate scheme). */
  additionalAccepts?: (req: Request) => CantonPaymentRequirements[] | Promise<CantonPaymentRequirements[]>;
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

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      x402?: {
        /** The signed transfer's sender: `verify.payer`, or read from the payload when the facilitator leaves it out. */
        payer: string;
        requirements: CantonPaymentRequirements;
        payload: CantonPaymentPayload;
        verify: VerifyResponse;
        settle?: SettleResponse;
      };
    }
  }
}

const DEFAULT_SCHEME = "exact";
const DEFAULT_MAX_TIMEOUT_SECONDS = 60;
const DEFAULT_EXECUTE_BEFORE_SECONDS = 120;

/** Internal control-flow signal: reject the request with a 402, echoing `requirements`. */
class PaymentRejection extends Error {
  constructor(
    readonly reason: string,
    readonly requirements: CantonPaymentRequirements,
    readonly details?: string,
    readonly extensions?: Record<string, unknown>,
  ) {
    super(reason);
  }
}

/**
 * Express middleware that gates a route behind an x402 payment.
 *
 * - No/invalid `X-PAYMENT` → `402` with `{ x402Version, accepts: [requirements] }`.
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
 *     network: "canton:devnet",
 *     payTo: "merchant::1220…",
 *     asset: { instrumentId: { id: "Amulet", admin: "DSO::1220…" } },
 *     amount: "500000000", // atomic units — 1 CC = 1e10, so this is 0.05 CC
 *   },
 * }));
 */
export function paymentRequired(options: PaymentRequiredOptions): RequestHandler {
  const { facilitator } = options;
  const settle = options.settle ?? false;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let extraAccepts: CantonPaymentRequirements[] = [];
    try {
      const fresh = await buildRequirements(req, options);
      // Advertised in the same 402, so held to the same rule.
      extraAccepts = options.additionalAccepts
        ? (await options.additionalAccepts(req)).map(assertAtomicAmount)
        : [];

      const header = req.header("X-PAYMENT");
      if (!header) throw new PaymentRejection("payment_required", fresh);

      // The payment carries the requirements it was built against as `accepted`,
      // the accepts[] entry the payer chose. Verify against those, after checking
      // them against merchant policy. Nothing in the payment binds them on its
      // own — what binds is the signed transfer the verifier decodes and compares
      // to them.
      let payload: CantonPaymentPayload;
      try {
        payload = decodePaymentHeader(header);
      } catch {
        throw new PaymentRejection("bad_payload", fresh);
      }
      // The codec checks `accepted` only for a scheme and a network, and types
      // it optimistically; nothing else in it has been checked. Narrow before
      // reading a field, or one without `extra` throws a TypeError and answers
      // 500 instead of 402 — attacker-controlled input choosing our status code.
      const requirements: unknown = payload.accepted;
      if (!isCantonPaymentRequirements(requirements)) {
        throw new PaymentRejection("policy_requirements_invalid", fresh);
      }

      const policyError = validateEchoedRequirements(requirements, fresh);
      if (policyError) throw new PaymentRejection(policyError, fresh);

      // The merchant's own checks, on everything the payer sent. Placed here so
      // a refusal costs no verify and, above all, no settle.
      const refusal = await options.checkPayment?.({ payload, requirements }, req);
      if (refusal) throw new PaymentRejection(refusal, fresh);

      // On any rejection, advertise `fresh` (this request's current terms) —
      // never the client's echoed requirements. Those are what the client just
      // failed on, and a merchant that issues a memo per challenge would be
      // handing a retrying agent back a reference it has already used.
      const verify = await facilitator.verify(payload, requirements);
      if (!verify.isValid) {
        const detail = verify.extensions?.detail;
        throw new PaymentRejection(
          verify.invalidReason ?? "verify_failed",
          fresh,
          typeof detail === "string" ? detail : undefined,
          verify.extensions,
        );
      }
      // The payload names no payer: it is the signed transfer's sender (spec
      // Rule 8), which the facilitator reports. `payer` is optional in a verify
      // response, so read the same sender here when it is left out — before
      // settling, so a payment is never captured for a request we then fail.
      const payer = verify.payer ?? decodePayloadTransfer(payload.payload.preparedTransaction)?.sender;
      if (!payer) throw new PaymentRejection("transfer_mismatch", fresh, "undecodable");

      let settleResponse: SettleResponse | undefined;
      if (settle) {
        settleResponse = await facilitator.settle(payload, requirements);
        if (!settleResponse.success) {
          throw new PaymentRejection(settleResponse.errorReason ?? "settle_failed", fresh, settleResponse.errorDetails);
        }
        res.setHeader("X-PAYMENT-RESPONSE", settleResponse.transaction);
      }

      req.x402 = { payer, requirements, payload, verify, settle: settleResponse };
      next();
    } catch (err) {
      let rejection: PaymentRejectionInfo | undefined;
      if (err instanceof PaymentRejection) {
        respond402(res, err.requirements, err.reason, err.details, extraAccepts);
        // A bare challenge (no X-PAYMENT yet) is the normal flow, not a rejection.
        if (err.reason !== "payment_required") {
          rejection = { status: 402, reason: err.reason, details: err.details, extensions: err.extensions };
        }
      } else if (err instanceof FacilitatorError) {
        res.status(502).json({ error: "facilitator_error", status: err.status, details: err.message });
        rejection = { status: 502, reason: "facilitator_error", details: err.message, error: err };
      } else {
        // Misconfiguration (e.g. invalid amount) or an unexpected throw.
        res.status(500).json({ error: "x402_middleware_error", details: errMsg(err) });
        rejection = { status: 500, reason: "x402_middleware_error", details: errMsg(err), error: err };
      }
      if (rejection && options.onReject) {
        // A failing hook must not affect the response, which is already sent.
        const onReject = options.onReject;
        void Promise.resolve()
          .then(() => onReject(rejection, req))
          .catch(() => {});
      }
    }
  };
}

async function buildRequirements(
  req: Request,
  options: PaymentRequiredOptions,
): Promise<CantonPaymentRequirements> {
  const source = options.requirements;
  if (typeof source === "function") return assertAtomicAmount(await source(req));

  const amount = await resolve(source.amount, req);
  const instrument = await resolve(source.asset, req);
  return assertAtomicAmount({
    scheme: await resolve(source.scheme ?? DEFAULT_SCHEME, req),
    network: await resolve(source.network, req),
    amount,
    // The merchant declares the instrument; the spec's `asset` is only a
    // symbol, so the full `{admin, id}` travels where a payer can read it.
    asset: assetSymbol(instrument.instrumentId),
    extra: {
      assetTransferMethod: ASSET_TRANSFER_METHOD,
      instrumentId: instrument.instrumentId,
      executeBeforeSeconds: source.executeBeforeSeconds
        ? await resolve(source.executeBeforeSeconds, req)
        : DEFAULT_EXECUTE_BEFORE_SECONDS,
      ...(source.memo ? { memo: await source.memo(req) } : {}),
    },
    payTo: await resolve(source.payTo, req),
    resource: source.resource ? await resolve(source.resource, req) : absoluteUrl(req),
    description: source.description ? await resolve(source.description, req) : `Access to ${req.path}`,
    maxTimeoutSeconds: source.maxTimeoutSeconds
      ? await resolve(source.maxTimeoutSeconds, req)
      : DEFAULT_MAX_TIMEOUT_SECONDS,
  });
}

/**
 * Every requirement this middleware advertises must carry an atomic amount.
 *
 * Checked here rather than in the declarative branch alone: a builder and
 * `additionalAccepts` produce requirements too, and a decimal from either used
 * to reach the 402 unchecked — then `BigInt(policy.amount)` threw on the paid
 * retry and answered 500. Failing where the requirement is built names the
 * merchant's own config instead.
 */
function assertAtomicAmount(r: CantonPaymentRequirements): CantonPaymentRequirements {
  if (!isValidAmount(r.amount)) {
    throw new Error(
      `paymentRequired: amount "${r.amount}" is not an integer string of atomic units`,
    );
  }
  return r;
}

/** Resolve a {@link Resolvable}: call it with the request if it's a function, else return it. */
async function resolve<T>(value: Resolvable<T>, req: Request): Promise<T> {
  return typeof value === "function" ? (value as (req: Request) => T | Promise<T>)(req) : value;
}

/**
 * Ensure the requirements the payer chose (`accepted`) are acceptable per
 * merchant policy: the scheme, network, `payTo`, resource, instrument, asset
 * and `maxTimeoutSeconds` must be this request's terms, and the amount must not
 * be under the price. Other fields (`description`, and the `extra` keys beyond
 * the instrument, `memo` and `executeBeforeSeconds` among them) are not
 * compared, and are forwarded as the payer sent them.
 */
function validateEchoedRequirements(
  echoed: CantonPaymentRequirements,
  policy: CantonPaymentRequirements,
): string | null {
  if (echoed.scheme !== policy.scheme) return "policy_scheme";
  if (echoed.network !== policy.network) return "policy_network";
  if (echoed.payTo !== policy.payTo) return "policy_payTo";
  // Bind the payment to THIS resource: without it, a payment minted for path A
  // (matching price/payTo/asset) could be replayed against path B.
  if (echoed.resource !== policy.resource) return "policy_resource";
  // The instrument, not the symbol: `asset` alone cannot say which registry
  // issued it, so comparing symbols would admit a look-alike from another.
  if (echoed.extra.instrumentId.id !== policy.extra.instrumentId.id) return "policy_asset";
  if (echoed.extra.instrumentId.admin !== policy.extra.instrumentId.admin) return "policy_asset";
  if (echoed.asset !== policy.asset) return "policy_asset";
  // Validate the FORMAT before comparing. BigInt throws on "abc" — a 500 where
  // a 402 belongs — and happily reads "0x10" as 16 and "" as 0, so a value the
  // merchant never quoted would compare as a number.
  if (!isValidAmount(echoed.amount)) return "policy_amount_invalid";
  // BigInt, not Number: atomic units are 1e10 larger than the token amount, so
  // anything over ~900k CC exceeds Number.MAX_SAFE_INTEGER and two different
  // prices start comparing equal.
  if (BigInt(echoed.amount) < BigInt(policy.amount)) return "policy_underpriced";
  // The facilitator holds a payment for at most this long; the payer does not
  // get to stretch it.
  if (echoed.maxTimeoutSeconds !== policy.maxTimeoutSeconds) return "policy_timeout";
  return null;
}

function respond402(
  res: Response,
  requirements: CantonPaymentRequirements,
  error: string,
  details: string | undefined,
  additional: CantonPaymentRequirements[],
): void {
  res.status(402).json({
    x402Version: 2,
    accepts: additional.length > 0 ? [requirements, ...additional] : [requirements],
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
