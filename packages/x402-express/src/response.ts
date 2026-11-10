// What the middleware sends when it will not let a request through.
//
// A 402 is where a challenge is ISSUED, not merely echoed: a refused payer
// needs terms it can pay, so the quotes are minted here rather than handing
// back the requirement it just failed on — which a retrying agent would
// re-send unchanged.
//
// SPDX-License-Identifier: Apache-2.0

import type { Request, Response } from "express";
import {
  encodePaymentRequiredHeader,
  type X402PaymentPayload,
  type ResourceInfo,
  type X402PaymentRequiredResponse,
  type X402PaymentRequirements,
} from "@chainsafe/x402-core";
import { FacilitatorError } from "@chainsafe/x402-client";

import type { BaseRequirementsSpec, SchemeAdapter } from "./scheme.js";
import type { PaymentRejectionInfo, PaymentRequiredOptions } from "./options.js";
import { buildQuotes, issueChallenge, type Offer } from "./quotes.js";

/**
 * Internal control-flow signal: answer this request with a 402.
 *
 * It carries no requirements. What the 402 advertises is a challenge issued at
 * the point of failure, not something decided when the rejection was raised.
 */
export class PaymentRejection extends Error {
  constructor(
    readonly reason: string,
    readonly details?: string,
    readonly extensions?: Record<string, unknown>,
  ) {
    super(reason);
  }
}

/** Send the response for anything thrown by the flow, and tell the merchant. */
export async function respondToFailure<
  TSpec extends BaseRequirementsSpec,
  TRequirements extends X402PaymentRequirements<unknown>,
  TPayload extends X402PaymentPayload<unknown>,
>(
  err: unknown,
  req: Request,
  res: Response,
  options: PaymentRequiredOptions<TSpec, TRequirements, TPayload>,
  scheme: SchemeAdapter<TSpec, TRequirements, TPayload>,
  built: Offer<TRequirements> | undefined,
): Promise<void> {
  let rejection: PaymentRejectionInfo | undefined;

  if (err instanceof PaymentRejection) {
    try {
      const offer = built ?? (await buildQuotes(req, options, scheme));
      respond402(res, offer.resource, await issueChallenge(offer.quotes), err.reason, err.details);
      // A bare challenge (no payment yet) is the normal flow, not a rejection.
      if (err.reason !== "payment_required") {
        rejection = {
          status: 402,
          reason: err.reason,
          details: err.details,
          extensions: err.extensions,
        };
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
  // Misconfiguration (e.g. invalid amount, no ways to pay) or an unexpected throw.
  res.status(500).json({ error: "x402_middleware_error", details: errMsg(err) });
  return { status: 500, reason: "x402_middleware_error", details: errMsg(err), error: err };
}

/**
 * Answer 402 with the spec's `PaymentRequired`: base64-encoded in the
 * `PAYMENT-REQUIRED` header, where the HTTP transport puts it, and as the body,
 * where clients of this middleware already read it. `details` is the body's
 * alone; the spec object has no such field.
 */
function respond402<TRequirements extends X402PaymentRequirements<unknown>>(
  res: Response,
  resource: ResourceInfo,
  accepts: TRequirements[],
  error: string,
  details: string | undefined,
): void {
  const paymentRequired: X402PaymentRequiredResponse<TRequirements> = {
    x402Version: 2,
    resource,
    accepts,
    error,
  };
  res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
  res.status(402).json({ ...paymentRequired, ...(details ? { details } : {}) });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
