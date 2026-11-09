/**
 * @chainsafe/x402-express
 *
 * Merchant-side Express middleware for x402 payments. `paymentRequired()`
 * returns 402 with `PaymentRequirements` when a request is unpaid, verifies the
 * payment via a facilitator (optionally settling it), and lets paid requests
 * through with `req.x402` attached.
 *
 * Canton's registered `exact` is the default scheme and needs no wiring. The
 * middleware itself is scheme-agnostic: pass a {@link SchemeAdapter} to gate a
 * route on something else.
 */
export const VERSION = "0.0.1";
export {
  paymentRequired,
  type PaymentRequiredOptions,
  type PaymentRejectionInfo,
  type RequirementsSpec,
  type RequirementsBuilder,
  type X402RequestState,
} from "./middleware.js";
export {
  resolve,
  sameValue,
  compareQuote,
  type BaseRequirementsSpec,
  type FieldRule,
  type Resolvable,
  type RuleTable,
  type SchemeAdapter,
  type SchemeContext,
  type SchemeQuote,
} from "./scheme.js";
export { cantonExact, type CantonRequirementsSpec } from "./schemes/canton-exact.js";
// The X-PAYMENT codec lives in @chainsafe/x402-core (shared by payer + merchant +
// facilitator). Re-exported here for convenience.
export { decodePaymentHeader, encodePaymentHeader, type DecodedPaymentHeader } from "@chainsafe/x402-core";
