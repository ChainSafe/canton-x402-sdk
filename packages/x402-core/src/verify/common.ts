// Scheme-agnostic verify primitives. Pure and stateless — usable standalone for
// a client self-check before paying. Anything scheme-specific (Ed25519, Canton
// fingerprints, canton-id shape) lives in the per-scheme module; anything
// stateful (nonce replay, on-chain proof) stays in the facilitator.

import { requirementsHash } from "../hashing";
import type { X402PaymentPayload } from "../types/payment";
import type { X402PaymentRequirements } from "../types/requirements";

// TWO LAYERS, TWO UNITS. `PaymentRequirements.amount` is an integer string of
// atomic units; an on-ledger transfer amount is a Daml `Decimal`. Daml's
// `Decimal` is `Numeric 10` — a fixed ten decimal places — so one atomic unit is
// 1e-10 of a token, for every Canton instrument rather than for Canton Coin
// specifically. The spec writes it as "1 CC = 1e10 units" because CC is its
// example.
const ATOMIC_PLACES = 10;

/** `PaymentRequirements.amount`: a non-negative integer string of atomic units. */
export function isValidAmount(amount: string): boolean {
  return /^\d+$/.test(amount);
}

/** An on-ledger transfer amount: a non-negative decimal with at most 10 places. */
export function isValidLedgerAmount(amount: string): boolean {
  return /^\d+(\.\d{1,10})?$/.test(amount);
}

/**
 * On-ledger `Decimal` → atomic units. `null` when the input is not a valid
 * ledger amount, so a malformed value can never compare equal to anything.
 */
export function ledgerToAtomic(amount: string): bigint | null {
  if (!isValidLedgerAmount(amount)) return null;
  const [whole, frac = ""] = amount.split(".");
  return BigInt(whole + frac.padEnd(ATOMIC_PLACES, "0"));
}

/**
 * Atomic units → on-ledger `Decimal`, trailing zeros trimmed. `null` on a
 * malformed input. The payer needs this: it quotes in atomic units and hands a
 * Decimal to the wallet SDK.
 */
export function atomicToLedger(amount: string): string | null {
  if (!isValidAmount(amount)) return null;
  const padded = amount.padStart(ATOMIC_PLACES + 1, "0");
  const whole = padded.slice(0, -ATOMIC_PLACES).replace(/^0+(?=\d)/, "");
  const frac = padded.slice(-ATOMIC_PLACES).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Does an on-ledger transfer amount equal the quoted atomic amount?
 *
 * EQUAL, not at-least. `exact` is the scheme's distinguishing property, and
 * Rule 4 says the transfer amount MUST equal `paymentRequirements.amount`
 * converted to Decimal. Accepting an overpayment takes funds the payer cannot
 * get back.
 *
 * Both sides normalise to atomic units first, so `0.30` and `0.3` are the same
 * amount and a malformed string on either side is never a match.
 */
export function amountMatches(ledgerAmount: string, atomicAmount: string): boolean {
  const got = ledgerToAtomic(ledgerAmount);
  if (got === null || !isValidAmount(atomicAmount)) return false;
  return got === BigInt(atomicAmount);
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
