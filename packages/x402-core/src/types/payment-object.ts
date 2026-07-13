import type { AssetSpec, DisclosedContract } from "./common";

/**
 * Request body for the facilitator's `/payment-object` endpoint. The client asks
 * the facilitator to route the Splice TransferFactory + choice context for a
 * given payer/merchant/asset, which it then feeds into the prepare call.
 */
export interface CantonPaymentObjectRequest {
  amount: string;
  merchantParty: string;
  payerParty: string;
  resource: string;
  description?: string;
  /** ISO 8601; when the resulting payment object expires. */
  expiresAt?: string;
  /** Optional x402 payment signature for validation. */
  x402Signature?: string;
  /** Optional webhook URL for async settlement notification. */
  notificationUrl?: string;
  /** Payer's holding contract IDs; the facilitator queries them if omitted. */
  holdingCids?: string[];
  /** Asset to settle in; defaults to Amulet (admin = DSO) when omitted. */
  asset?: AssetSpec;
}

/**
 * The routed TransferFactory + choice context the client feeds into
 * `/v2/interactive-submission/prepare`.
 */
export interface CantonPaymentObject {
  amount: string;
  merchantParty: string;
  payerParty: string;
  expiresAt: string;
  resource: string;
  description?: string;
  /** Facilitator fee (decimal string); "0.00" today. */
  facilitatorFee: string;
  /** amount + facilitatorFee. */
  totalAmount: string;
  transferFactory: {
    contractId: string;
    disclosedContracts: DisclosedContract[];
  };
  /** Opaque Splice Token Standard choice context (registry-specific). */
  choiceContext: Record<string, unknown>;
}

export interface CantonPaymentObjectResponse {
  paymentObject: CantonPaymentObject;
  paymentId: string;
  status: "ready" | "pending" | "completed";
  notificationUrl?: string;
}
