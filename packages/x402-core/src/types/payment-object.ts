import * as v from "valibot";
import { AssetSpecSchema, DisclosedContractSchema } from "./common";

/**
 * Request body for the facilitator's `/payment-object` endpoint. The client asks
 * the facilitator to route the Splice TransferFactory + choice context for a
 * given payer/merchant/asset, which it then feeds into the prepare call.
 */
export const CantonPaymentObjectRequestSchema = v.object({
  amount: v.string(),
  merchantParty: v.string(),
  payerParty: v.string(),
  resource: v.string(),
  description: v.optional(v.string()),
  /** ISO 8601; when the resulting payment object expires. */
  expiresAt: v.optional(v.string()),
  /** Optional x402 payment signature for validation. */
  x402Signature: v.optional(v.string()),
  /** Optional webhook URL for async settlement notification. */
  notificationUrl: v.optional(v.string()),
  /** Payer's holding contract IDs; the facilitator queries them if omitted. */
  holdingCids: v.optional(v.array(v.string())),
  /** Asset to settle in; defaults to Amulet (admin = DSO) when omitted. */
  asset: v.optional(AssetSpecSchema),
});
export type CantonPaymentObjectRequest = v.InferOutput<typeof CantonPaymentObjectRequestSchema>;

/**
 * The routed TransferFactory + choice context the client feeds into
 * `/v2/interactive-submission/prepare`.
 */
export const CantonPaymentObjectSchema = v.object({
  amount: v.string(),
  merchantParty: v.string(),
  payerParty: v.string(),
  expiresAt: v.string(),
  resource: v.string(),
  description: v.optional(v.string()),
  /** Facilitator fee (decimal string); "0.00" today. */
  facilitatorFee: v.string(),
  /** amount + facilitatorFee. */
  totalAmount: v.string(),
  transferFactory: v.object({
    contractId: v.string(),
    disclosedContracts: v.array(DisclosedContractSchema),
  }),
  /** Opaque Splice Token Standard choice context (registry-specific). */
  choiceContext: v.record(v.string(), v.unknown()),
});
export type CantonPaymentObject = v.InferOutput<typeof CantonPaymentObjectSchema>;

export const CantonPaymentObjectResponseSchema = v.object({
  paymentObject: CantonPaymentObjectSchema,
  paymentId: v.string(),
  status: v.picklist(["ready", "pending", "completed"]),
  notificationUrl: v.optional(v.string()),
});
export type CantonPaymentObjectResponse = v.InferOutput<typeof CantonPaymentObjectResponseSchema>;
