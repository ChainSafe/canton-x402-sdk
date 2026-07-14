import type { AssetSpec, NetworkId, X402Version } from "./common";

/**
 * PaymentRequirements — sent by the merchant in the 402 response's accepts[].
 */
export interface CantonPaymentRequirements {
  // Widened from the literal `"exact-canton"` so additional schemes can share
  // the envelope. Each scheme guards on the literal it recognises.
  // FUTURE: use the shared `Scheme` open union (common.ts) for autocomplete.
  scheme: string;
  network: NetworkId;
  /** Decimal-string CC amount, up to 10 decimal places. */
  // FUTURE: a branded `DecimalString` type would document the format at the type level.
  maxAmountRequired: string;
  // FUTURE: the ONLY chain-specific field here — becomes the `TAsset` slot (see index header).
  asset: AssetSpec;
  /** Recipient Canton party ID. */
  payTo: string;
  /** Resource URL the wallet is paying for. */
  resource: string;
  description?: string;
  /** Unique nonce; UUID v4 recommended. */
  nonce: string;
  /** ISO 8601 timestamp; facilitator rejects /settle after this. */
  validBefore: string;
  maxTimeoutSeconds?: number;
  // FUTURE: scheme-specific shape → the `TExtra` slot (see index header); e.g. the
  // bridge's `cantonRecipient` instead of an untyped bag.
  extra?: Record<string, unknown>;
}

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
