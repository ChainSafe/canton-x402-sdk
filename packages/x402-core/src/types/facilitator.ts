import type { AssetSpec, NetworkId, X402Version } from "./common";
import type { CantonPaymentInner, X402PaymentPayload } from "./payment";
import type { X402PaymentRequirements } from "./requirements";

/**
 * Generic request body for POST /v2/verify and /v2/settle — payload + requirements,
 * parameterized by the same scheme seams. The two operations take the identical
 * envelope, so `SettleRequest` aliases `VerifyRequest`.
 */
export interface X402Request<
  TInner = CantonPaymentInner,
  TAsset = AssetSpec,
  TExtra = Record<string, unknown>,
> {
  x402Version: X402Version;
  paymentPayload: X402PaymentPayload<TInner>;
  paymentRequirements: X402PaymentRequirements<TAsset, TExtra>;
}

/** exact-canton verify/settle request. */
export type VerifyRequest = X402Request;
export type SettleRequest = VerifyRequest;

// FUTURE: appending `| (string & {})` to the reason unions below would let a
// newer facilitator return a reason an older client doesn't know without
// breaking deserialization — at the cost of losing exhaustive-switch checking.
// Decide deliberately before doing it.
export type VerifyInvalidReason =
  | "scheme_mismatch"
  | "network_mismatch"
  | "requirements_expired"
  | "requirements_hash_mismatch"
  | "bad_fingerprint"
  | "bad_signature"
  | "nonce_replayed"
  | "missing_public_key"
  | "internal_error";

export interface VerifyResponseValid {
  isValid: true;
  payer?: string;
  /** Scheme-specific extra fields (mirrors upstream x402 v2 `extensions`). */
  extensions?: Record<string, unknown>;
}

export interface VerifyResponseInvalid {
  isValid: false;
  invalidReason: VerifyInvalidReason;
  payer?: string;
  extensions?: Record<string, unknown>;
}

/** Discriminated on `isValid`. */
export type VerifyResponse = VerifyResponseValid | VerifyResponseInvalid;

export type SettleErrorReason =
  | "bad_request"
  | "unauthorized"
  | "scheme_mismatch"
  | "network_mismatch"
  | "requirements_expired"
  | "requirements_hash_mismatch"
  | "bad_fingerprint"
  | "bad_signature"
  | "nonce_replayed"
  | "execution_failed"
  | "timeout"
  | "facilitator_error";

export interface SettleResponseSuccess {
  success: true;
  network: NetworkId;
  /** Canton updateId of the executed transaction. */
  transaction: string;
  completionOffset?: string;
  payer: string;
  extensions?: Record<string, unknown>;
}

export interface SettleResponseError {
  success: false;
  errorReason: SettleErrorReason;
  errorDetails?: string;
}

/** Discriminated on `success`. */
export type SettleResponse = SettleResponseSuccess | SettleResponseError;

export interface SupportedKind {
  x402Version: X402Version;
  scheme: string;
  network: NetworkId;
  extra?: Record<string, unknown>;
}

export interface SupportedResponse {
  kinds: SupportedKind[];
}
