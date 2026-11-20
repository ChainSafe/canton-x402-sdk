// Holding the requirements a payment accepted against the merchant's own terms.
//
// The middleware owns the fields x402 v2 gives every scheme; a scheme owns
// `extra`, and its table is spliced in here. Each field is compared by a rule
// in a table, walked by compareQuote below.
//
// SPDX-License-Identifier: Apache-2.0

import {
  isValidAmount,
  type CantonPaymentRequirements,
  type X402PaymentRequirements,
} from "@chainsafe/x402-core";

import type { Quote } from "./quotes.js";
import { PaymentRejection } from "./response.js";

/** How one field of an echoed requirement is held against the merchant's. */
export type FieldRule =
  /** Must be exactly what the merchant quoted. */
  | { compare: "equal"; reason: string }
  /** An integer-string amount that must be at least the merchant's. */
  | { compare: "atLeast"; reason: string; invalidReason: string }
  /** Walk a nested table. */
  | { compare: "nested"; rules: RuleTable }
  /** Not compared, with the reason recorded here rather than left to inference. */
  | { compare: "skip"; why: string };

export type RuleTable = Record<string, FieldRule>;

/** Structural equality over the JSON these fields are made of. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameValue(item, b[i]));
  }
  const ae = Object.entries(a as Record<string, unknown>);
  const be = b as Record<string, unknown>;
  if (ae.length !== Object.keys(be).length) return false;
  return ae.every(([k, v]) => k in be && sameValue(v, be[k]));
}

/**
 * Walk a rule table, comparing an echoed requirement against one quote.
 *
 * `depth` counts the comparisons that passed before the one that failed. It is
 * how the middleware decides which of several advertised quotes a payment was
 * aimed at when it matches none of them: the quote it got furthest through is
 * the one whose refusal is worth reporting.
 */
export function compareQuote(
  echoed: Record<string, unknown>,
  policy: Record<string, unknown>,
  rules: RuleTable,
  depth = 0,
): { ok: true; depth: number } | { ok: false; reason: string; depth: number } {
  let passed = depth;
  for (const [field, rule] of Object.entries(rules)) {
    switch (rule.compare) {
      case "skip":
        continue;
      case "equal":
        if (!sameValue(echoed[field], policy[field])) {
          return { ok: false, reason: rule.reason, depth: passed };
        }
        break;
      case "atLeast": {
        const e = echoed[field];
        // Validate the FORMAT before comparing, with core's bound and not a
        // bare integer test. BigInt throws on "abc" — a 500 where a 402 belongs
        // — and happily reads "0x10" as 16 and "" as 0, so a value the merchant
        // never quoted would compare as a number. The LENGTH bound matters too:
        // BigInt parsing is superlinear, and a million-digit echoed amount
        // reaches here before any signature is checked.
        if (typeof e !== "string" || !isValidAmount(e)) {
          return { ok: false, reason: rule.invalidReason, depth: passed };
        }
        if (BigInt(e) < BigInt(policy[field] as string)) {
          return { ok: false, reason: rule.reason, depth: passed };
        }
        break;
      }
      case "nested": {
        const nested = compareQuote(
          echoed[field] as Record<string, unknown>,
          policy[field] as Record<string, unknown>,
          rule.rules,
          passed,
        );
        if (!nested.ok) return nested;
        passed = nested.depth;
        break;
      }
    }
    passed += 1;
  }
  return { ok: true, depth: passed };
}

/**
 * The protocol's common requirement fields, keyed off the one concrete schema
 * that enumerates them.
 *
 * Keyed off a schema rather than written out so a field added to the
 * requirements fails the build here until someone says what comparing it means.
 * A hand-kept list simply ignores fields nobody remembered to add — which is
 * the quiet way an unchecked field becomes something a payer can set freely.
 */
const COMMON_RULES: Record<
  keyof CantonPaymentRequirements,
  RuleTable[string]
> = {
  scheme: { compare: "equal", reason: "policy_scheme" },
  network: { compare: "equal", reason: "policy_network" },
  payTo: { compare: "equal", reason: "policy_payTo" },
  asset: { compare: "equal", reason: "policy_asset" },
  // Overpaying is the payer's business; underpaying is not. Compared as BigInt,
  // because atomic units are 1e10 larger than the token amount — anything over
  // ~900k CC exceeds Number.MAX_SAFE_INTEGER and two prices start comparing
  // equal.
  amount: {
    compare: "atLeast",
    reason: "policy_underpriced",
    invalidReason: "policy_amount_invalid",
  },
  // Replaced per scheme in rulesFor().
  extra: { compare: "skip", why: "filled in from the scheme adapter" },
  // The seconds the client is given to complete payment. It never reaches the
  // ledger — `extra.executeBeforeSeconds` is the deadline that does — so it is
  // compared for echo fidelity: the payer does not get to name its own.
  maxTimeoutSeconds: { compare: "equal", reason: "policy_timeout" },
};

/** The common rules with this scheme's `extra` rules spliced in. */
export function rulesFor(scheme: { extraRules: RuleTable }): RuleTable {
  return { ...COMMON_RULES, extra: { compare: "nested", rules: scheme.extraRules } };
}

/**
 * Hold the quote a payment says it accepted against the ones this request would
 * advertise, and throw a {@link PaymentRejection} carrying a `policy_*` reason
 * when none takes it.
 *
 * Nothing on the wire says which quote a payment is for — there is no quote id
 * in the payload — so it passes if ANY advertised quote is satisfied. That is
 * what lets a merchant advertise more than one.
 *
 * The reason comes from the quote the payment got FURTHEST through, so a payer
 * underpaying the second way to pay is told it underpaid rather than told about
 * the first way's instrument.
 */
export function assertAcceptedQuote<TRequirements extends X402PaymentRequirements<unknown>>(
  accepted: TRequirements,
  quotes: Array<Quote<TRequirements>>,
  rules: RuleTable,
): void {
  let furthest: { reason: string; depth: number } | undefined;
  for (const quote of quotes) {
    const result = compareQuote(
      accepted as unknown as Record<string, unknown>,
      quote.requirements as unknown as Record<string, unknown>,
      rules,
    );
    if (result.ok) return;
    if (!furthest || result.depth > furthest.depth) {
      furthest = { reason: result.reason, depth: result.depth };
    }
  }
  // buildQuotes never returns an empty list, so `furthest` is always set.
  throw new PaymentRejection(furthest?.reason ?? "policy_requirements_invalid");
}
