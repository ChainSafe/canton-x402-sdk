// Scheme-agnostic verify primitives. Pure and stateless — usable standalone for
// a client self-check before paying. Anything scheme-specific (Ed25519, Canton
// fingerprints, canton-id shape) lives in the per-scheme module; anything
// stateful (replay, on-chain proof) stays in the facilitator.

import type { X402PaymentPayload } from "../types/payment";
import type { X402PaymentRequirements } from "../types/requirements";

/** Decimal places every Canton instrument uses on the wire: 1 token = 1e10. */
export const WIRE_DECIMALS = 10;

// BOUNDED ON PURPOSE. Both forms are parsed with BigInt on unauthenticated
// input — the middleware compares an echoed amount before any signature is
// checked — and BigInt parsing is superlinear: ~300ms for three million digits
// against ~6ms for Number. A merchant following our own guidance runs with
// `maxHeaderSize: 4 * 1024 * 1024`, so an unbounded pattern hands an attacker
// that cost for the price of one request.
//
// The limits are Daml's, not arbitrary: `Numeric 10` carries 38 digits of
// precision with ten after the point, so a ledger amount has at most 28 integer
// digits, and the atomic form — that value times 1e10 — has at most 38. Nothing
// longer can exist on ledger to be quoted in the first place.
const MAX_LEDGER_INTEGER_DIGITS = 28;
const MAX_ATOMIC_DIGITS = 38;

/** `PaymentRequirements.amount`: a non-negative integer string of atomic units. */
export function isValidAmount(amount: string): boolean {
  return new RegExp(`^\\d{1,${MAX_ATOMIC_DIGITS}}$`).test(amount);
}

/** An on-ledger transfer amount: a non-negative decimal with at most 10 places. */
export function isValidLedgerAmount(amount: string): boolean {
  return new RegExp(`^\\d{1,${MAX_LEDGER_INTEGER_DIGITS}}(\\.\\d{1,10})?$`).test(amount);
}

/**
 * On-ledger `Decimal` → atomic units at `decimals` places. `null` when the
 * input is not a valid ledger amount, so a malformed value can never compare
 * equal to anything.
 *
 * `decimals` is required rather than defaulted: the scale is the one thing a
 * caller must have decided, and a default would let a new instrument be priced
 * at Canton Coin's scale by omission.
 */
export function ledgerToAtomic(amount: string, decimals: number): bigint | null {
  if (!isValidLedgerAmount(amount) || !Number.isInteger(decimals) || decimals < 0) return null;
  const [whole, frac = ""] = amount.split(".");
  if (frac.length > decimals) return null; // more precision than the instrument has
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

/** Atomic units → on-ledger `Decimal` at `decimals` places, trailing zeros trimmed. */
export function atomicToLedger(amount: string, decimals: number): string | null {
  if (!isValidAmount(amount) || !Number.isInteger(decimals) || decimals < 0) return null;
  if (decimals === 0) return amount.replace(/^0+(?=\d)/, "");
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, "");
  const frac = padded.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** The payload's scheme + network must match the requirements. */
export function schemeNetworkMatches(
  payload: X402PaymentPayload<unknown>,
  requirements: X402PaymentRequirements<unknown>,
): boolean {
  return payload.scheme === requirements.scheme && payload.network === requirements.network;
}
