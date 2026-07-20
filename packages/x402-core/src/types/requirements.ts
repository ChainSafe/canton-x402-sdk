import type { AssetSpec, NetworkId, X402Version } from "./common";

/**
 * Generic PaymentRequirements — the merchant's 402 offer. The scheme-specific seams
 * are `TAsset` (the asset descriptor) and `TExtra` (the scheme's `extra` bag); every
 * other field is shared. `scheme` stays a plain string so schemes share the envelope.
 */
export interface X402PaymentRequirements<TAsset = AssetSpec, TExtra = Record<string, unknown>> {
  // FUTURE: use the shared `Scheme` open union (common.ts) for autocomplete.
  scheme: string;
  network: NetworkId;
  /**
   * Maximum amount to charge, as a decimal string denominated in `asset`.
   * Precision is scheme-defined.
   */
  // FUTURE: a branded `DecimalString` type would document the format at the type level.
  maxAmountRequired: string;
  /** The scheme-specific asset descriptor (the `TAsset` seam). */
  asset: TAsset;
  /** Recipient party ID. */
  payTo: string;
  /** Resource URL the wallet is paying for. */
  resource: string;
  description?: string;
  /** Unique nonce; UUID v4 recommended. */
  nonce: string;
  /** ISO 8601 timestamp; facilitator rejects /settle after this. */
  validBefore: string;
  maxTimeoutSeconds?: number;
  /** Scheme-specific extra (the `TExtra` seam), e.g. the bridge's `cantonRecipient`. */
  extra?: TExtra;
}

/** exact-canton requirements: a Splice {@link AssetSpec}, sent in the 402's accepts[]. */
export type CantonPaymentRequirements = X402PaymentRequirements<AssetSpec>;

/**
 * The `402 Payment Required` response body — returned by the merchant/resource
 * server, listing the payment options the client may satisfy. The client picks
 * one of `accepts[]`, pays it, and retries the request with the `X-PAYMENT`
 * header. Produced by the merchant middleware; parsed by the auto-pay client.
 */
export interface PaymentRequiredResponse {
  x402Version: X402Version;
  /** Payment options; the client satisfies exactly one of them. */
  accepts: CantonPaymentRequirements[];
  /** Optional machine-readable reason, e.g. "payment_required". */
  error?: string;
}
