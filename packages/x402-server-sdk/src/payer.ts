import type { CantonPaymentPayload, CantonPaymentRequirements } from "@chainsafe/x402-core";

/**
 * Scheme-agnostic payer contract. The auto-pay fetch wrapper depends on this, not
 * on a specific implementation, so a future scheme's payer drops in without
 * touching it. `CantonX402Payer` (canton-payer.ts) is the exact-canton implementation.
 */
export interface X402Payer {
  /** Whether this payer can satisfy a requirement (scheme + network + asset). */
  supports(requirements: CantonPaymentRequirements): boolean;
  /** Prepare + sign a payment, returning the payload a facilitator settles. */
  authorize(requirements: CantonPaymentRequirements): Promise<CantonPaymentPayload>;
}
