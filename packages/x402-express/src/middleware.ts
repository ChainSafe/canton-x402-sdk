// The request lifecycle: challenge, verify, settle, or refuse.
//
// What is here is the protocol's, whatever the scheme — when a challenge is
// issued, which advertised quote a payment is for, what reaches the
// facilitator, and what each failure answers. A scheme owns `extra` and is
// reached only through the adapter; see scheme.ts.
//
// SPDX-License-Identifier: Apache-2.0

import type { Request, Response, NextFunction, RequestHandler } from "express";
import {
  decodePaymentHeader,
  encodePaymentResponseHeader,
  isSettlementPending,
  type CantonPaymentPayload,
  type CantonPaymentRequirements,
  type SettleResponse,
  type VerifyResponse,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from "@chainsafe/x402-core";
import type { FacilitatorClient } from "@chainsafe/x402-client";

import type { BaseRequirementsSpec, SchemeAdapter } from "./scheme.js";
import { cantonExact, type CantonRequirementsSpec } from "./schemes/canton-exact.js";
import type { PaymentRejectionInfo, PaymentRequiredOptions, X402RequestState } from "./options.js";
import { assertUsableTerms, buildQuotes, type Offer } from "./quotes.js";
import { assertAcceptedQuote, rulesFor } from "./policy.js";
import type { RuleTable } from "./policy.js";
import { PaymentRejection, SettlementPending, causeOf, respondToFailure } from "./response.js";

/**
 * Express middleware that gates a route behind an x402 payment.
 *
 * Two signatures: the first is the default canton-exact scheme, which keeps the
 * concrete types so an inline spec is contextually typed against them. The
 * second is the generic one, for a route gated on another scheme via
 * `PaymentRequiredOptions.scheme`.
 *
 * - No/invalid payment in `PAYMENT-SIGNATURE` (or the older `X-PAYMENT`) →
 *   `402` with the spec's `PaymentRequired`, `{ x402Version, resource, accepts }`,
 *   in the `PAYMENT-REQUIRED` header and as the body. One `accepts[]` entry per
 *   way to pay; entries sharing a reference generator are issued one freshly
 *   minted reference between them, a 402 being one sale.
 * - Valid payment → verify (and optionally settle) via the facilitator, then
 *   attach `req.x402` and call `next()`. A settle answer, success or failure,
 *   goes back in the `PAYMENT-RESPONSE` header.
 *
 * @example
 * app.use("/paid", paymentRequired({
 *   facilitator,
 *   settle: true,
 *   requirements: {
 *     payTo: "merchant::1220…",
 *     resource: "https://merchant.example/report",
 *     accepts: [
 *       { amount: "500000000", asset: "Amulet" }, // 0.05 CC
 *       { amount: "250000", asset: "USDCx" },     // priced separately
 *     ],
 *   },
 * }));
 */
export function paymentRequired(options: PaymentRequiredOptions): RequestHandler;
// `scheme` is required here, and that is load-bearing rather than tidiness: a
// canton call with an incomplete way to pay would otherwise fall through to
// this overload, infer TSpec from whatever it was given, and typecheck — then
// fail at mount. Without a scheme there is only one overload to fail against.
export function paymentRequired<
  TSpec extends BaseRequirementsSpec,
  TRequirements extends X402PaymentRequirements<unknown>,
  TPayload extends X402PaymentPayload<unknown>,
>(
  options: PaymentRequiredOptions<TSpec, TRequirements, TPayload> & {
    scheme: SchemeAdapter<TSpec, TRequirements, TPayload>;
  },
): RequestHandler;
export function paymentRequired<
  TSpec extends BaseRequirementsSpec = CantonRequirementsSpec,
  TRequirements extends X402PaymentRequirements<unknown> = CantonPaymentRequirements,
  TPayload extends X402PaymentPayload<unknown> = CantonPaymentPayload,
>(options: PaymentRequiredOptions<TSpec, TRequirements, TPayload>): RequestHandler {
  const { facilitator } = options;
  const scheme = (options.scheme ?? cantonExact) as unknown as SchemeAdapter<
    TSpec,
    TRequirements,
    TPayload
  >;
  const rules = rulesFor(scheme);
  // Merchant config, so it is checked here, once, and not per request.
  assertUsableTerms(options.requirements, scheme);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Built once per request, and reused by the failure path.
    let offer: Offer<TRequirements> | undefined;
    // Set at ONE point: once `preSettle` has accepted. From there a refusal may
    // be undoing work the merchant did, and this names it. Any earlier and it
    // would name a payment nothing has checked: an underpriced header echoing
    // another order's reference would hand `onReject` that reference.
    let payment: PaymentRejectionInfo<TRequirements, TPayload>["payment"];
    try {
      const { payload, accepted } = readPayment(req, scheme);
      offer = await buildQuotes(req, options, scheme);
      holdToTerms(payload, accepted, offer, rules);
      const { verify, payer } = await verifyPayment(facilitator, scheme, payload, accepted);

      // The merchant's own say, on a payment the facilitator has vouched for:
      // after verify, so `accepted` is bound to the signed transfer and
      // `payer` is known, and before settle, so a refusal moves no funds.
      const refusal = await options.preSettle?.(
        { payload, requirements: accepted, payer, verify },
        req,
      );
      if (refusal) throw new PaymentRejection(refusal);
      payment = { payload, requirements: accepted, payer };

      const settled = options.settle
        ? await settlePayment(facilitator, payload, accepted, res)
        : undefined;
      req.x402 = {
        payer,
        requirements: accepted,
        payload,
        verify,
        settle: settled,
      } as X402RequestState;
      next();
    } catch (err) {
      await respondToFailure(err, req, res, options, scheme, offer, payment);
    }
  };
}

/**
 * The payment in `PAYMENT-SIGNATURE` (or the older `X-PAYMENT`), narrowed to
 * this scheme's shapes. No header is the plain challenge; anything else that
 * fails here is a 402 refusal.
 */
function readPayment<
  TSpec extends BaseRequirementsSpec,
  TRequirements extends X402PaymentRequirements<unknown>,
  TPayload extends X402PaymentPayload<unknown>,
>(
  req: Request,
  scheme: SchemeAdapter<TSpec, TRequirements, TPayload>,
): { payload: TPayload; accepted: TRequirements } {
  const header = req.header("PAYMENT-SIGNATURE") || req.header("X-PAYMENT");
  if (!header) throw new PaymentRejection("payment_required");

  let decoded: X402PaymentPayload<unknown>;
  try {
    decoded = decodePaymentHeader(header);
  } catch {
    throw new PaymentRejection("bad_payload");
  }
  // The codec checks the envelope only, and types the result optimistically;
  // these guards are what look at `payload` and `accepted`. Narrow before
  // reading a field, or attacker-controlled input picks our status code by
  // throwing a TypeError into the 500 path.
  if (!scheme.acceptsPayload(decoded)) throw new PaymentRejection("policy_payload_invalid");
  if (!scheme.acceptsRequirements(decoded.accepted)) {
    throw new PaymentRejection("policy_requirements_invalid");
  }
  return { payload: decoded, accepted: decoded.accepted };
}

/**
 * Hold the payment against the terms this request would advertise: the
 * requirements it says it accepted, and the resource it names, if any.
 *
 * Nothing the payer sends here is signed, so this is echo fidelity: what binds
 * the payment is the transfer the facilitator verifies against `accepted`.
 */
function holdToTerms<TRequirements extends X402PaymentRequirements<unknown>>(
  payload: X402PaymentPayload<unknown>,
  accepted: TRequirements,
  offer: Offer<TRequirements>,
  rules: RuleTable,
): void {
  assertAcceptedQuote(accepted, offer.quotes, rules);
  // §5.2.2 lets a payment name its resource; optional, but another one is refused.
  const named = payload.resource?.url;
  if (named !== undefined && named !== offer.resource.url) {
    throw new PaymentRejection("policy_resource");
  }
}

/**
 * Verify with the facilitator, and find who paid.
 *
 * The payload names no payer: it is the signed transfer's sender (spec
 * Rule 8). The facilitator reports it, and `payer` is optional in a verify
 * response, so the scheme reads its own when it is left out.
 */
async function verifyPayment<
  TSpec extends BaseRequirementsSpec,
  TRequirements extends X402PaymentRequirements<unknown>,
  TPayload extends X402PaymentPayload<unknown>,
>(
  facilitator: FacilitatorClient,
  scheme: SchemeAdapter<TSpec, TRequirements, TPayload>,
  payload: TPayload,
  accepted: TRequirements,
): Promise<{ verify: VerifyResponse; payer: string }> {
  const verify = await facilitator.verify(payload, accepted);
  if (!verify.isValid) {
    throw new PaymentRejection(verify.invalidReason ?? "verify_failed", {
      details: causeOf(verify.extensions),
      extensions: verify.extensions,
    });
  }
  const payer = verify.payer ?? scheme.payerOf(payload);
  if (!payer) {
    // Worded as the scheme's verifier words an undecodable transfer.
    throw new PaymentRejection(scheme.unreadablePayerReason ?? "invalid_payload", {
      details: "undecodable",
      extensions: { detail: "undecodable" },
    });
  }
  return { verify, payer };
}

/**
 * Settle with the facilitator, and put its answer in `PAYMENT-RESPONSE`.
 *
 * Pending is not a failure: the transfer was relayed and may still commit, so
 * it is answered without serving and without a fresh challenge, which would
 * have the payer sign a second transfer while the first may land.
 */
async function settlePayment(
  facilitator: FacilitatorClient,
  payload: X402PaymentPayload<unknown>,
  accepted: X402PaymentRequirements<unknown>,
  res: Response,
): Promise<SettleResponse> {
  const settled = await facilitator.settle(payload, accepted);
  if (isSettlementPending(settled)) throw new SettlementPending(settled);
  if (!settled.success) {
    // Showing `errorMessage` is fine; matching on it is what x402 v2 §9 rules out.
    throw new PaymentRejection(settled.errorReason ?? "settle_failed", {
      details: causeOf(settled.extensions, settled.errorMessage),
      settleResponse: settled,
    });
  }
  res.setHeader("PAYMENT-RESPONSE", encodePaymentResponseHeader(settled));
  return settled;
}
