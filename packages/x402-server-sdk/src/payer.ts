import type {
  CantonPaymentPayload,
  CantonPaymentRequirements,
  ResourceInfo,
} from "@chainsafe/x402-core";

/**
 * What the 402 said, beyond the entry being paid.
 *
 * `PaymentRequirements` names no resource — x402 v2 puts it on `PaymentRequired`
 * — so a payer that wants to echo it back in `PaymentPayload.resource` has to be
 * handed it.
 */
export interface PaymentContext {
  /** The resource the 402 named. */
  resource?: ResourceInfo;
}

/**
 * Scheme-agnostic payer contract. The auto-pay fetch wrapper depends on this, not
 * on a specific implementation, so a future scheme's payer drops in without
 * touching it. `CantonX402Payer` (canton-payer.ts) is the canton-exact implementation.
 */
export interface X402Payer {
  /** Whether this payer can satisfy a requirement (scheme + network + transfer method + asset). */
  supports(requirements: CantonPaymentRequirements): boolean;
  /**
   * Prepare + sign a payment, returning the payload a facilitator settles. Its
   * `accepted` must be `requirements`, whole: `createX402Fetch` sends the payment
   * alone, and the merchant takes the requirements to verify against from it.
   */
  authorize(
    requirements: CantonPaymentRequirements,
    context?: PaymentContext,
  ): Promise<CantonPaymentPayload>;
}
