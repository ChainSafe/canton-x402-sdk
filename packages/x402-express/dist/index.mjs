// src/middleware.ts
import { randomUUID } from "crypto";
import {
  isValidAmount,
  decodePaymentHeader
} from "@chainsafe/x402-core";
import { FacilitatorError } from "@chainsafe/x402-client";
var DEFAULT_SCHEME = "exact-canton";
var DEFAULT_VALIDITY_SECONDS = 300;
var PaymentRejection = class extends Error {
  constructor(reason, requirements, details) {
    super(reason);
    this.reason = reason;
    this.requirements = requirements;
    this.details = details;
  }
  reason;
  requirements;
  details;
};
function paymentRequired(options) {
  const { facilitator } = options;
  const settle = options.settle ?? false;
  return async (req, res, next) => {
    let extraAccepts = [];
    try {
      const fresh = await buildRequirements(req, options);
      extraAccepts = options.additionalAccepts ? await options.additionalAccepts(req) : [];
      const header = req.header("X-PAYMENT");
      if (!header) throw new PaymentRejection("payment_required", fresh);
      let payload;
      let requirements;
      try {
        ({ payload, requirements } = decodePaymentHeader(header));
      } catch {
        throw new PaymentRejection("bad_payload", fresh);
      }
      const policyError = validateEchoedRequirements(requirements, fresh);
      if (policyError) throw new PaymentRejection(policyError, fresh);
      const verify = await facilitator.verify(payload, requirements);
      if (!verify.isValid) throw new PaymentRejection(verify.invalidReason ?? "verify_failed", fresh);
      let settleResponse;
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
        res.status(500).json({ error: "x402_middleware_error", details: errMsg(err) });
      }
    }
  };
}
async function buildRequirements(req, options) {
  const source = options.requirements;
  if (typeof source === "function") return source(req);
  const amount = await resolve(source.amount, req);
  if (!isValidAmount(amount)) {
    throw new Error(`paymentRequired: amount "${amount}" is not a valid decimal amount`);
  }
  const validForSeconds = source.validForSeconds ? await resolve(source.validForSeconds, req) : DEFAULT_VALIDITY_SECONDS;
  return {
    scheme: await resolve(source.scheme ?? DEFAULT_SCHEME, req),
    network: await resolve(source.network, req),
    maxAmountRequired: amount,
    asset: await resolve(source.asset, req),
    payTo: await resolve(source.payTo, req),
    resource: source.resource ? await resolve(source.resource, req) : absoluteUrl(req),
    description: source.description ? await resolve(source.description, req) : `Access to ${req.path}`,
    nonce: source.nonce ? await source.nonce(req) : randomUUID(),
    validBefore: new Date(Date.now() + validForSeconds * 1e3).toISOString()
  };
}
async function resolve(value, req) {
  return typeof value === "function" ? value(req) : value;
}
function validateEchoedRequirements(echoed, policy) {
  if (echoed.scheme !== policy.scheme) return "policy_scheme";
  if (echoed.network !== policy.network) return "policy_network";
  if (echoed.payTo !== policy.payTo) return "policy_payTo";
  if (echoed.resource !== policy.resource) return "policy_resource";
  if (echoed.asset.instrumentId.id !== policy.asset.instrumentId.id) return "policy_asset";
  if (echoed.asset.instrumentId.admin !== policy.asset.instrumentId.admin) return "policy_asset";
  if (!isValidAmount(echoed.maxAmountRequired)) return "policy_amount_invalid";
  if (Number(echoed.maxAmountRequired) < Number(policy.maxAmountRequired)) return "policy_underpriced";
  if (Date.parse(echoed.validBefore) <= Date.now()) return "requirements_expired";
  return null;
}
function respond402(res, requirements, error, details, additional) {
  res.status(402).json({
    x402Version: 2,
    accepts: additional.length > 0 ? [requirements, ...additional] : [requirements],
    error,
    ...details ? { details } : {}
  });
}
function absoluteUrl(req) {
  return `${req.protocol}://${req.get("host") ?? ""}${req.originalUrl}`;
}
function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}

// src/index.ts
import { decodePaymentHeader as decodePaymentHeader2, encodePaymentHeader } from "@chainsafe/x402-core";
var VERSION = "0.0.1";
export {
  VERSION,
  decodePaymentHeader2 as decodePaymentHeader,
  encodePaymentHeader,
  paymentRequired
};
//# sourceMappingURL=index.mjs.map