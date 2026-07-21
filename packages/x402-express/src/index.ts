/**
 * @chainsafe/x402-express
 *
 * Merchant-side Express middleware for x402 payments on Canton. `paymentRequired()`
 * returns 402 with `PaymentRequirements` when a request is unpaid, verifies the
 * payment via a facilitator (optionally settling it), and lets paid requests
 * through with `req.x402` attached.
 */
export const VERSION = "0.0.1";
export {
  paymentRequired,
  type PaymentRequiredOptions,
  type RequirementsSpec,
  type RequirementsBuilder,
  type Resolvable,
} from "./middleware.js";
// The X-PAYMENT codec lives in @chainsafe/x402-core (shared by payer + merchant +
// facilitator). Re-exported here for convenience.
export { decodePaymentHeader, encodePaymentHeader, type DecodedPaymentHeader } from "@chainsafe/x402-core";
