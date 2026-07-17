import type { Request, Response, NextFunction, RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import {
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
 * Declarative requirements: the middleware fills in `validBefore` (and `nonce`,
 * unless you supply a generator) and applies defaults. Fields may be a fixed value
 * or a per-request resolver.
 */
export interface RequirementsSpec {
  /** Merchant party receiving payment. */
  payTo: Resolvable<string>;
  /** Asset to charge in. */
  asset: Resolvable<AssetSpec>;
  /** scheme+network id, e.g. `canton:1220…`. */
  network: Resolvable<string>;
  /** Price (decimal string). */
  amount: Resolvable<string>;
  /** Scheme id. Default `exact-canton`. */
  scheme?: Resolvable<string>;
  /** Resource URL. Default: the request's absolute URL. */
  resource?: Resolvable<string>;
  /** Human description. Default: `Access to <path>`. */
  description?: Resolvable<string>;
  /** Validity window in seconds for the built `validBefore`. Default 300. */
  validForSeconds?: Resolvable<number>;
  /**
   * Generate (and, if you want, persist) the challenge nonce for this request —
   * e.g. record it merchant-side for reconciliation. Called once per challenge, so
   * it MUST return a fresh, unique value each time. Omit to let the middleware
   * generate a random UUID. (Function-only by design: a static value would reuse
   * one nonce across challenges.)
   */
  nonce?: (req: Request) => string | Promise<string>;
}

/**
 * Full control: build the entire `PaymentRequirements` per request (you own
 * `nonce` + `validBefore`).
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
  /** Extra `accepts[]` entries for the 402 body (e.g. an alternate scheme). */
  additionalAccepts?: (req: Request) => CantonPaymentRequirements[] | Promise<CantonPaymentRequirements[]>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      x402?: {
        payer: string;
        requirements: CantonPaymentRequirements;
        payload: CantonPaymentPayload;
        verify: VerifyResponse;
        settle?: SettleResponse;
      };
    }
  }
}

const DEFAULT_SCHEME = "exact-canton";
const DEFAULT_VALIDITY_SECONDS = 300;

/** Internal control-flow signal: reject the request with a 402, echoing `requirements`. */
class PaymentRejection extends Error {
  constructor(
    readonly reason: string,
    readonly requirements: CantonPaymentRequirements,
    readonly details?: string,
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
 *     network: "canton:1220…",
 *     payTo: "merchant::1220…",
 *     asset: { instrumentId: { id: "Amulet", admin: "DSO::1220…" } },
 *     amount: "0.05", // or a per-request (req) => "0.05"
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
      extraAccepts = options.additionalAccepts ? await options.additionalAccepts(req) : [];

      const header = req.header("X-PAYMENT");
      if (!header) throw new PaymentRejection("payment_required", fresh);

      // The X-PAYMENT envelope carries the requirements the payload was signed
      // against; verify against those (their requirementsHash binds to a specific
      // nonce + validBefore), after checking them against merchant policy.
      let payload: CantonPaymentPayload;
      let requirements: CantonPaymentRequirements;
      try {
        ({ payload, requirements } = decodePaymentHeader(header));
      } catch {
        throw new PaymentRejection("bad_payload", fresh);
      }

      const policyError = validateEchoedRequirements(requirements, fresh);
      if (policyError) throw new PaymentRejection(policyError, fresh);

      // On any rejection, advertise `fresh` (this request's current terms) — never
      // the client's echoed requirements. The echoed copy differs from `fresh` in
      // nonce + validBefore, so returning it would hand a retrying agent back a
      // dead challenge (a replayed/expired nonce) and trap it in a loop.
      const verify = await facilitator.verify(payload, requirements);
      if (!verify.isValid) throw new PaymentRejection(verify.invalidReason ?? "verify_failed", fresh);

      let settleResponse: SettleResponse | undefined;
      if (settle) {
        settleResponse = await facilitator.settle(payload, requirements);
        if (!settleResponse.success) {
          throw new PaymentRejection(settleResponse.errorReason ?? "settle_failed", fresh, settleResponse.errorDetails);
        }
        res.setHeader("X-PAYMENT-RESPONSE", settleResponse.transaction);
      }

      req.x402 = { payer: verify.payer ?? payload.payload.payer, requirements, payload, verify, settle: settleResponse };
      next();
    } catch (err) {
      if (err instanceof PaymentRejection) {
        respond402(res, err.requirements, err.reason, err.details, extraAccepts);
      } else if (err instanceof FacilitatorError) {
        res.status(502).json({ error: "facilitator_error", status: err.status, details: err.message });
      } else {
        // Misconfiguration (e.g. invalid amount) or an unexpected throw.
        res.status(500).json({ error: "x402_middleware_error", details: errMsg(err) });
      }
    }
  };
}

async function buildRequirements(
  req: Request,
  options: PaymentRequiredOptions,
): Promise<CantonPaymentRequirements> {
  const source = options.requirements;
  if (typeof source === "function") return source(req);

  const amount = await resolve(source.amount, req);
  if (!isValidAmount(amount)) {
    throw new Error(`paymentRequired: amount "${amount}" is not a valid decimal amount`);
  }
  const validForSeconds = source.validForSeconds
    ? await resolve(source.validForSeconds, req)
    : DEFAULT_VALIDITY_SECONDS;
  return {
    scheme: await resolve(source.scheme ?? DEFAULT_SCHEME, req),
    network: await resolve(source.network, req),
    maxAmountRequired: amount,
    asset: await resolve(source.asset, req),
    payTo: await resolve(source.payTo, req),
    resource: source.resource ? await resolve(source.resource, req) : absoluteUrl(req),
    description: source.description ? await resolve(source.description, req) : `Access to ${req.path}`,
    nonce: source.nonce ? await source.nonce(req) : randomUUID(),
    validBefore: new Date(Date.now() + validForSeconds * 1000).toISOString(),
  };
}

/** Resolve a {@link Resolvable}: call it with the request if it's a function, else return it. */
async function resolve<T>(value: Resolvable<T>, req: Request): Promise<T> {
  return typeof value === "function" ? (value as (req: Request) => T | Promise<T>)(req) : value;
}

/** Ensure client-echoed requirements are acceptable per merchant policy. */
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
  if (echoed.asset.instrumentId.id !== policy.asset.instrumentId.id) return "policy_asset";
  if (echoed.asset.instrumentId.admin !== policy.asset.instrumentId.admin) return "policy_asset";
  // The merchant priced this request; an echoed requirement must not undercut it.
  if (Number(echoed.maxAmountRequired) < Number(policy.maxAmountRequired)) return "policy_underpriced";
  if (Date.parse(echoed.validBefore) <= Date.now()) return "requirements_expired";
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
