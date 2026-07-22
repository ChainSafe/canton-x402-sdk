import { Request, RequestHandler } from 'express';
import { CantonPaymentRequirements, CantonPaymentPayload, VerifyResponse, SettleResponse, AssetSpec } from '@chainsafe/x402-core';
export { DecodedPaymentHeader, decodePaymentHeader, encodePaymentHeader } from '@chainsafe/x402-core';
import { FacilitatorClient } from '@chainsafe/x402-client';

/** A fixed value, or one computed per request. */
type Resolvable<T> = T | ((req: Request) => T | Promise<T>);
/**
 * Declarative requirements: the middleware fills in `validBefore` (and `nonce`,
 * unless you supply a generator) and applies defaults. Fields may be a fixed value
 * or a per-request resolver.
 */
interface RequirementsSpec {
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
type RequirementsBuilder = (req: Request) => CantonPaymentRequirements | Promise<CantonPaymentRequirements>;
/** Configuration for {@link paymentRequired}. */
interface PaymentRequiredOptions {
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
declare function paymentRequired(options: PaymentRequiredOptions): RequestHandler;

/**
 * @chainsafe/x402-express
 *
 * Merchant-side Express middleware for x402 payments on Canton. `paymentRequired()`
 * returns 402 with `PaymentRequirements` when a request is unpaid, verifies the
 * payment via a facilitator (optionally settling it), and lets paid requests
 * through with `req.x402` attached.
 */
declare const VERSION = "0.0.1";

export { type PaymentRequiredOptions, type RequirementsBuilder, type RequirementsSpec, type Resolvable, VERSION, paymentRequired };
