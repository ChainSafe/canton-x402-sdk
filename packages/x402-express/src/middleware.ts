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
  type CantonPaymentPayload,
  type CantonPaymentRequirements,
  type SettleResponse,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from "@chainsafe/x402-core";

import type { BaseRequirementsSpec, SchemeAdapter } from "./scheme.js";
import { cantonExact, type CantonRequirementsSpec } from "./schemes/canton-exact.js";
import {
  assertUsableTerms,
  type PaymentRejectionInfo,
  type PaymentRequiredOptions,
  type X402RequestState,
} from "./options.js";
import { buildQuotes, type Quote } from "./quotes.js";
import { assertAcceptedQuote, rulesFor } from "./policy.js";
import { PaymentRejection, respondToFailure } from "./response.js";

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
 *   way to pay, each with its own freshly minted reference.
 * - Valid payment → verify (and optionally settle) via the facilitator, then
 *   attach `req.x402` and call `next()`.
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
  // Merchant config, so it is checked here, once, and not per request.
  assertUsableTerms(options.requirements, scheme);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Built at most once per request, and only when something needs them: a
    // paid request needs terms to hold the payment against, a challenge needs
    // terms to advertise. The failure path reuses whatever was built here.
    let quotes: Array<Quote<TRequirements>> | undefined;
    // Kept for the failure path: a refusal after this point names the payment
    // it refused, so a merchant can undo whatever `preSettle` did.
    let payment: PaymentRejectionInfo<TRequirements, TPayload>["payment"];
    try {
      // The spec's name first. X-PAYMENT is the name this SDK used before, and
      // is still read for a payment of this shape sent under it. A 0.1.x payer
      // sends the older { payment, requirements } shape, which is refused
      // either way.
      const header = req.header("PAYMENT-SIGNATURE") || req.header("X-PAYMENT");
      // No payment yet. Nothing is built for the terms' own sake — the
      // challenge below is what gets built, references and all.
      if (!header) throw new PaymentRejection("payment_required");

      // The payment carries the requirements it was built against as
      // `accepted`, the accepts[] entry the payer chose. Verify against those,
      // after checking them against merchant policy. Nothing in the payment
      // binds them on its own — what binds is the signed transfer the verifier
      // decodes and compares to them.
      let decoded: X402PaymentPayload<unknown>;
      try {
        decoded = decodePaymentHeader(header);
      } catch {
        throw new PaymentRejection("bad_payload");
      }

      // The codec checks the envelope only: `payload.payload` is `{}` as far as
      // it is concerned, `accepted` is checked for the fields every scheme's
      // requirements share, and neither `extra` nor `resource` is checked at
      // all. It types the result optimistically; these guards are the only
      // things that have looked. Narrow before reading a field, or
      // attacker-controlled input picks our status code by throwing a
      // TypeError into the 500 path.
      if (!scheme.acceptsPayload(decoded)) throw new PaymentRejection("policy_payload_invalid");
      if (!scheme.acceptsRequirements(decoded.accepted)) {
        throw new PaymentRejection("policy_requirements_invalid");
      }
      const payload = decoded as TPayload;
      const accepted = decoded.accepted as TRequirements;
      payment = { payload, requirements: accepted };

      quotes = await buildQuotes(req, options, scheme);
      assertAcceptedQuote(accepted, quotes, rules);

      const verify = await facilitator.verify(payload, accepted);
      if (!verify.isValid) {
        const detail = verify.extensions?.detail;
        throw new PaymentRejection(
          verify.invalidReason ?? "verify_failed",
          typeof detail === "string" ? detail : undefined,
          verify.extensions,
        );
      }

      // The payload names no payer — it is the signed transfer's sender (spec
      // Rule 8), which the facilitator reports. `payer` is optional in a verify
      // response, so ask the scheme to read its own when it is left out. Before
      // settling, so a payment is never captured for a request we then fail.
      const payer = verify.payer ?? scheme.payerOf(payload);
      payment = { ...payment, payer };
      if (!payer) {
        // Worded as the scheme's verifier words an undecodable transfer, with
        // the protocol-level reason kept in `extensions` for a reader that
        // knows that one and not the scheme's.
        throw new PaymentRejection(
          scheme.unreadablePayerReason ?? "transfer_mismatch",
          "undecodable",
          { reason: "transfer_mismatch", detail: "undecodable" },
        );
      }

      // The merchant's own say, on a payment the facilitator has vouched for:
      // after verify, so `accepted` is bound to the signed transfer and
      // `payer` is known, and before settle, so a refusal moves no funds.
      const merchantRefusal = await options.preSettle?.(
        { payload, requirements: accepted, payer, verify },
        req,
      );
      if (merchantRefusal) throw new PaymentRejection(merchantRefusal);

      let settleResponse: SettleResponse | undefined;
      if (settle) {
        settleResponse = await facilitator.settle(payload, accepted);
        if (!settleResponse.success) {
          throw new PaymentRejection(
            settleResponse.errorReason ?? "settle_failed",
            settleResponse.errorDetails,
          );
        }
        res.setHeader("X-PAYMENT-RESPONSE", settleResponse.transaction);
      }

      req.x402 = {
        payer,
        requirements: accepted,
        payload,
        verify,
        settle: settleResponse,
      } as X402RequestState;
      next();
    } catch (err) {
      await respondToFailure(err, req, res, options, scheme, quotes, payment);
    }
  };
}
