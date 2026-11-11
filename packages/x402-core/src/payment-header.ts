// Payment header codec — the single source of truth for serialising and
// deserialising the x402 payment envelope. Shared by the payer (builds the
// header), the merchant middleware (reads it), and the facilitator. The 402's
// `PAYMENT-REQUIRED` header is base64(JSON) the same way, so its encoder lives
// here too.
//
// ── The envelope ────────────────────────────────────────────────────────────
// The payment travels in the `PAYMENT-SIGNATURE` request header (x402 v2 HTTP
// transport), which this SDK called `X-PAYMENT` before; the merchant
// middleware still reads that name. Either way the value is base64(JSON) of
// the x402 v2 PaymentPayload, nothing around it:
//
//   { "x402Version": 2,
//     "accepted": { "scheme": "exact", "network": "canton:devnet", "amount": "…", "payTo": "…", … },
//     "payload":  { "preparedTransaction": "…", "signature": "…", … } }
//
// `accepted` is the `accepts[]` entry the payer chose, so the requirements the
// payment was built against travel inside it. Verification is stateless: the
// facilitator checks the signed transfer against one specific requirements
// object — its receiver, instrument, amount and memo — and that is the one the
// merchant forwards, after validating it against its own policy.
//
// Isomorphic on purpose (browser + node): base64 via btoa/atob, UTF-8 via
// TextEncoder/TextDecoder — no Node Buffer.

import { isX402PaymentPayload, isX402PaymentRequiredResponse } from "./types";
import type { CantonPaymentPayload } from "./types/payment";
import type {
  CantonPaymentRequiredResponse,
  X402PaymentRequiredResponse,
} from "./types/requirements";

/**
 * The deepest a decoded payment may nest. A real one is a handful of levels
 * deep. `JSON.parse` accepts far deeper, but `JSON.stringify` overflows the
 * stack at a few thousand levels when the payment is forwarded to the
 * facilitator, turning a refusal into a 500; `extensions` and the unchecked
 * keys of `accepted` can carry such a value.
 */
export const MAX_PAYMENT_DEPTH = 64;

/**
 * Serialise a payment into a `PAYMENT-SIGNATURE` header value ({@link decodePaymentHeader}
 * is the inverse). Scheme-agnostic at runtime (it just serialises); generic so any
 * scheme's payload can be encoded.
 */
export function encodePaymentHeader<TPayload = CantonPaymentPayload>(payload: TPayload): string {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(payload)));
}

/**
 * Serialise a 402's `PaymentRequired` into a `PAYMENT-REQUIRED` response header
 * value: base64 of its UTF-8 JSON, as the x402 v2 HTTP transport carries it and
 * as `PAYMENT-SIGNATURE` carries a payment. Generic so any scheme's `accepts[]` can be
 * encoded.
 */
export function encodePaymentRequiredHeader<TRequirements>(
  paymentRequired: X402PaymentRequiredResponse<TRequirements>,
): string {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(paymentRequired)));
}

/**
 * Parse a `PAYMENT-REQUIRED` header value into the `PaymentRequired` it carries.
 *
 * The counterpart of {@link encodePaymentRequiredHeader}, and the way a client
 * should read a 402: the HTTP transport makes the header the canonical
 * location and calls the response body a server implementation concern, so a
 * merchant may well answer `{}` — every registered Canton merchant does.
 *
 * Throws on bad base64 / JSON, on nesting past {@link MAX_PAYMENT_DEPTH}, or
 * when the value is not an x402 v2 `PaymentRequired` (version 2, a `resource`
 * with a `url`, and an `accepts[]` whose entries carry the fields every
 * scheme's requirements share).
 *
 * Validation is envelope-level and scheme-agnostic, as {@link
 * decodePaymentHeader}'s is: a 402 may offer canton-exact beside another
 * scheme, and reading each entry as canton-exact would throw out an offer over
 * an entry this reader was never going to pay. Typed as canton-exact for
 * caller convenience, which is optimistic — a caller picking an entry must
 * still check its own scheme can pay it.
 */
export function decodePaymentRequiredHeader(headerValue: string): CantonPaymentRequiredResponse {
  let raw: string;
  try {
    raw = new TextDecoder().decode(base64ToBytes(headerValue));
  } catch (err) {
    throw new Error(`PAYMENT-REQUIRED header is not valid base64: ${errMsg(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`PAYMENT-REQUIRED header is not valid JSON: ${errMsg(err)}`);
  }
  if (nestsDeeperThan(parsed, MAX_PAYMENT_DEPTH)) {
    throw new Error(`PAYMENT-REQUIRED header nests deeper than ${MAX_PAYMENT_DEPTH} levels`);
  }
  if (!isX402PaymentRequiredResponse(parsed)) {
    throw new Error(
      "PAYMENT-REQUIRED header is not an x402 v2 PaymentRequired (x402Version 2, resource, accepts)",
    );
  }
  // Optimistically typed as canton-exact, as the payment decoder is: whether
  // an entry is one this reader can pay is checked per entry, by the payer.
  return parsed as CantonPaymentRequiredResponse;
}

/**
 * Parse a `PAYMENT-SIGNATURE` (or `X-PAYMENT`) header value into the payment it carries. Throws on bad
 * base64 / JSON, or when the value is not a well-formed x402 v2 payment envelope,
 * including the pre-spec `{ payment, requirements }` wrapper, a payment with no
 * `accepted`, and one whose `accepted` is not a whole `PaymentRequirements` (a
 * field every scheme's requirements share, missing or empty).
 *
 * Validation here is **envelope-level and scheme-agnostic** (x402 v2, an
 * `accepted` with the fields every scheme's requirements share, a payload
 * object) — deliberately *not* the concrete per-scheme inner, or the rest of
 * `accepted`. Concrete validation is the verifier's job: the facilitator (or a
 * local {@link createCantonExactVerifier}) checks the scheme-specific inner +
 * asset and the signature before the payment is trusted. This keeps the codec
 * one scheme-agnostic seam and avoids duplicating per-scheme knowledge here.
 *
 * The result is typed as the canton-exact payload for caller convenience; that's
 * optimistic — a caller MUST verify before relying on scheme-specific fields, and
 * narrow `accepted` before reading more than the fields every scheme shares.
 */
export function decodePaymentHeader(headerValue: string): CantonPaymentPayload {
  let raw: string;
  try {
    raw = new TextDecoder().decode(base64ToBytes(headerValue));
  } catch (err) {
    throw new Error(`payment header is not valid base64: ${errMsg(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`payment header is not valid JSON: ${errMsg(err)}`);
  }
  if (nestsDeeperThan(parsed, MAX_PAYMENT_DEPTH)) {
    throw new Error(`payment header nests deeper than ${MAX_PAYMENT_DEPTH} levels`);
  }
  if (!isX402PaymentPayload(parsed)) {
    throw new Error("payment header is not an x402 v2 payment (x402Version 2, accepted, payload)");
  }
  // Optimistically typed as canton-exact; the inner/asset are verified by the
  // verifier, not here.
  return parsed as CantonPaymentPayload;
}

/** True iff `value` has objects or arrays nested more than `max` deep. Iterative, so a deep value cannot overflow the stack here either. */
function nestsDeeperThan(value: unknown, max: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [unknown, number];
    if (typeof node !== "object" || node === null) continue;
    if (depth > max) return true;
    for (const child of Array.isArray(node) ? node : Object.values(node)) stack.push([child, depth + 1]);
  }
  return false;
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
