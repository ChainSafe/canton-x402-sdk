// X-PAYMENT header codec — the single source of truth for serialising and
// deserialising the x402 payment envelope. Shared by the payer (builds the
// header), the merchant middleware (reads it), and the facilitator.
//
// ── The envelope ────────────────────────────────────────────────────────────
// `X-PAYMENT` is base64(JSON) of a two-slot wrapper: the payment, and the
// requirements it was signed against.
//
//   {
//     "payment":      { "x402Version": 2, "scheme": "exact-canton", "network": "canton:1220…",
//                       "payload": { "payer": "…", "partySignature": "…", "requirementsHash": "…" } },
//     "requirements": { "scheme": "exact-canton", "nonce": "…", "validBefore": "…", … }
//   }
//
// Two slots (not a merge) so each is validated independently on decode (at the
// envelope level — see decodePaymentHeader), and `payment` (not `payload`) at the
// top disambiguates from the payment's own inner `.payload`.
//
// The requirements are mandatory: verification is stateless, and `requirementsHash`
// binds to a specific requirements object (its exact nonce + validBefore), so that
// object must travel back with the payment for the facilitator to recompute the
// hash and check the signature. A payment without them is unverifiable. The
// merchant validates the echoed requirements against its policy before trusting them.
//
// Isomorphic on purpose (browser + node): base64 via btoa/atob, UTF-8 via
// TextEncoder/TextDecoder — no Node Buffer.

import { isX402PaymentPayload, isX402PaymentRequirements } from "./types";
import type { CantonPaymentPayload } from "./types/payment";
import type { CantonPaymentRequirements } from "./types/requirements";

/**
 * The decoded X-PAYMENT slots. Generic over the payment + requirements types so a
 * future scheme can parameterize it; both default to the exact-canton concrete
 * types, so existing use (and `decodePaymentHeader`'s return) is unchanged. Widening
 * to another scheme later needs no breaking change here.
 */
export interface DecodedPaymentHeader<
  TPayload = CantonPaymentPayload,
  TRequirements = CantonPaymentRequirements,
> {
  payload: TPayload;
  /** The requirements the payload was signed against, echoed from the 402. */
  requirements: TRequirements;
}

/**
 * Serialise a payment together with the requirements it was signed against into
 * an `X-PAYMENT` header value ({@link decodePaymentHeader} is the inverse).
 * Scheme-agnostic at runtime (it just serialises); generic over the two slot types
 * so any scheme's payload/requirements can be encoded.
 */
export function encodePaymentHeader<
  TPayload = CantonPaymentPayload,
  TRequirements = CantonPaymentRequirements,
>(payload: TPayload, requirements: TRequirements): string {
  const envelope = { payment: payload, requirements };
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(envelope)));
}

/**
 * Parse an `X-PAYMENT` header value into its `payment` + `requirements` slots.
 * Throws on bad base64 / JSON / envelope shape, or when either slot is missing or
 * not a well-formed x402 envelope.
 *
 * Validation here is **envelope-level and scheme-agnostic** (x402 v2 shape, a scheme,
 * a network, a payload object, the universal requirements fields) — deliberately *not*
 * the concrete per-scheme inner. Concrete validation is the verifier's job: the
 * facilitator (or a local {@link createExactCantonVerifier}) checks the scheme-specific
 * inner + asset and the signature before the payment is trusted. This keeps the codec
 * one scheme-agnostic seam and avoids duplicating per-scheme knowledge here.
 *
 * The slots are typed as the exact-canton concrete types by default (see
 * {@link DecodedPaymentHeader}) for caller convenience; that's optimistic — a caller
 * MUST verify before relying on scheme-specific fields. A future scheme narrows via
 * the generic parameters.
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
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("X-PAYMENT did not decode to a { payment, requirements } envelope");
  }
  const { payment, requirements } = parsed as { payment?: unknown; requirements?: unknown };
  if (!isX402PaymentPayload(payment)) {
    throw new Error("X-PAYMENT `payment` slot is missing or not a valid payment envelope");
  }
  if (!isX402PaymentRequirements(requirements)) {
    throw new Error("X-PAYMENT `requirements` slot is missing or not valid payment requirements");
  }
  // Optimistically typed as the exact-canton concrete types (the DecodedPaymentHeader
  // defaults); the inner/asset are verified by the verifier, not here.
  return {
    payload: payment as CantonPaymentPayload,
    requirements: requirements as CantonPaymentRequirements,
  };
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
