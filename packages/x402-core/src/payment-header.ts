// X-PAYMENT header codec — the single source of truth for serialising and
// deserialising the x402 payment envelope. Shared by the payer (builds the
// header), the merchant middleware (reads it), and the facilitator.
//
// ── The envelope ────────────────────────────────────────────────────────────
// `X-PAYMENT` is base64(JSON) of a CantonPaymentPayload carrying the
// `paymentRequirements` the payload was signed against:
//
//   {
//     "x402Version": 2,
//     "scheme": "exact-canton",
//     "network": "canton:1220…",
//     "payload": { "payer": "…", "partySignature": "…", "requirementsHash": "…" },
//     "paymentRequirements": { "nonce": "…", "validBefore": "…", … }
//   }
//
// The requirements are mandatory: verification is stateless, and `requirementsHash`
// binds to a specific requirements object (its exact nonce + validBefore), so that
// object must travel back with the payment for the facilitator to recompute the
// hash and check the signature. A payload without them is unverifiable. The
// merchant validates the echoed requirements against its policy before trusting them.
//
// Isomorphic on purpose (browser + node): base64 via btoa/atob, UTF-8 via
// TextEncoder/TextDecoder — no Node Buffer.

import { isX402PaymentPayload } from "./verify";
import type { CantonPaymentPayload } from "./types/payment";
import type { CantonPaymentRequirements } from "./types/requirements";

export interface DecodedPaymentHeader {
  payload: CantonPaymentPayload;
  /** The requirements the payload was signed against, echoed from the 402. */
  requirements: CantonPaymentRequirements;
}

/**
 * Serialise a payment together with the requirements it was signed against into
 * an `X-PAYMENT` header value. Inverse of {@link decodePaymentHeader}.
 */
export function encodePaymentHeader(
  payload: CantonPaymentPayload,
  requirements: CantonPaymentRequirements,
): string {
  const envelope = { ...payload, paymentRequirements: requirements };
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(envelope)));
}

/**
 * Parse an `X-PAYMENT` header value into the payment payload and the requirements
 * it was signed against. Throws on bad base64 / JSON / envelope shape, or when the
 * requirements are missing.
 */
export function decodePaymentHeader(headerValue: string): DecodedPaymentHeader {
  let raw: string;
  try {
    raw = new TextDecoder().decode(base64ToBytes(headerValue));
  } catch (err) {
    throw new Error(`X-PAYMENT is not valid base64: ${errMsg(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`X-PAYMENT is not valid JSON: ${errMsg(err)}`);
  }
  if (!isX402PaymentPayload(parsed)) {
    throw new Error("X-PAYMENT did not decode to an x402 payment payload (check scheme/x402Version/payload)");
  }
  const { paymentRequirements, ...payload } = parsed as CantonPaymentPayload & {
    paymentRequirements?: CantonPaymentRequirements;
  };
  if (!paymentRequirements) {
    throw new Error("X-PAYMENT is missing paymentRequirements (the requirements the payload was signed against)");
  }
  return { payload: payload as CantonPaymentPayload, requirements: paymentRequirements };
}

/** bytes → base64. Isomorphic: `btoa` is global in Node 18+ and browsers. */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** base64 → bytes. Isomorphic: `atob` is global in Node 18+ and browsers. */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
