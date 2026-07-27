// Scheme-agnostic verify primitives. Pure and stateless — usable standalone for
// a client self-check before paying. Anything scheme-specific (Ed25519, Canton
// fingerprints, canton-id shape) lives in the per-scheme module; anything
// stateful (nonce replay, on-chain proof) stays in the facilitator.

import { requirementsHash } from "../hashing";
import type { X402PaymentPayload } from "../types/payment";
import type { X402PaymentRequirements } from "../types/requirements";

/** Decimal string with up to 10 fractional places (matches `maxAmountRequired`). */
export function isValidAmount(amount: string): boolean {
  return /^\d+(\.\d{1,10})?$/.test(amount);
}

/**
 * Decimal-safe `a >= b` for x402 amount strings (non-negative, ≤10dp). Compares
 * via integer scaling with BigInt — no float rounding. Returns false if either
 * string is not a valid amount, so a malformed input never reads as "enough".
 */
export function amountGte(a: string, b: string): boolean {
  if (!isValidAmount(a) || !isValidAmount(b)) return false;
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const scale = Math.max(af.length, bf.length);
  const an = BigInt(ai + af.padEnd(scale, "0"));
  const bn = BigInt(bi + bf.padEnd(scale, "0"));
  return an >= bn;
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
