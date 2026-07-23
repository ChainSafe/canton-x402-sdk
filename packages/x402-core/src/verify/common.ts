// Scheme-agnostic verify primitives. Pure and stateless — usable standalone for
// a client self-check before paying. Anything scheme-specific (Ed25519, Canton
// fingerprints, canton-id shape) lives in the per-scheme module; anything
// stateful (nonce replay, on-chain proof) stays in the facilitator.

import { requirementsHash } from "../hashing";
import type { X402PaymentPayload } from "../types/payment";
import type { X402PaymentRequirements } from "../types/requirements";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Decimal string with up to 10 fractional places (matches `maxAmountRequired`). */
export function isValidAmount(amount: string): boolean {
  return /^\d+(\.\d{1,10})?$/.test(amount);
}

/** True iff `validBefore` (ISO 8601) is unparseable or at/before `now` (expired). */
export function isExpired(validBefore: string, now: number = Date.now()): boolean {
  const t = Date.parse(validBefore);
  return !Number.isFinite(t) || t <= now;
}

/** The payload's scheme + network must match the requirements. */
export function schemeNetworkMatches(
  payload: X402PaymentPayload<unknown>,
  requirements: X402PaymentRequirements<unknown>,
): boolean {
  return payload.scheme === requirements.scheme && payload.network === requirements.network;
}

/**
 * True iff a claimed `requirementsHash` (hex) equals the canonical hash of the
 * requirements — the binding that stops a signed payload being replayed against a
 * different (resource, amount, payTo, …). Scheme-agnostic: the canonicalizer walks
 * the requirements structurally.
 */
export function requirementsHashMatches(
  requirements: X402PaymentRequirements<unknown>,
  claimedHashHex: string,
): boolean {
  return requirementsHash(requirements) === claimedHashHex;
}

/**
 * Loose guard for the outer payment envelope: x402 v2, any non-empty scheme (the
 * per-scheme verifier validates the inner `payload` shape), a network, and a
 * `payload` object. Scheme-agnostic — intentionally does NOT assert any scheme's
 * inner fields; use a scheme guard (e.g. `isCantonPaymentInner`) for that.
 */
export function isX402PaymentPayload(v: unknown): v is X402PaymentPayload<unknown> {
  if (!isObj(v)) return false;
  return (
    v.x402Version === 2 &&
    typeof v.scheme === "string" &&
    v.scheme.length > 0 &&
    typeof v.network === "string" &&
    isObj(v.payload)
  );
}
