// Holding an echoed requirement against the merchant's own terms.
//
// The middleware owns the fields x402 v2 gives every scheme; a scheme owns
// `extra`, and its table is spliced in here. See scheme.ts for how a table is
// walked.
//
// SPDX-License-Identifier: Apache-2.0

import {
  CantonPaymentRequirementsSchema,
  type X402PaymentRequirements,
} from "@chainsafe/x402-core";

import { compareQuote, type RuleTable } from "./scheme.js";
import type { Quote } from "./quotes.js";

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
  keyof typeof CantonPaymentRequirementsSchema.entries,
  RuleTable[string]
> = {
  scheme: { compare: "equal", reason: "policy_scheme" },
  network: { compare: "equal", reason: "policy_network" },
  payTo: { compare: "equal", reason: "policy_payTo" },
  // Bind the payment to THIS resource: without it, a payment minted for path A
  // (matching price/payTo/asset) could be replayed against path B.
  resource: { compare: "equal", reason: "policy_resource" },
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
  // Does not reach the ledger, so it does not change what settles. Left
  // uncompared so a payer library that normalises or drops it still pays.
  description: { compare: "skip", why: "informational" },
  // The facilitator holds a payment for at most this long; the payer does not
  // get to stretch it.
  maxTimeoutSeconds: { compare: "equal", reason: "policy_timeout" },
};

/** The common rules with this scheme's `extra` rules spliced in. */
export function rulesFor(scheme: { extraRules: RuleTable }): RuleTable {
  return { ...COMMON_RULES, extra: { compare: "nested", rules: scheme.extraRules } };
}

/**
 * Which advertised quote is this payment for, if any? Returns the reason to
 * refuse it, or `undefined` when one accepts it.
 *
 * Nothing on the wire names one — there is no quote id in the payload — so the
 * answer is whichever quote the echoed requirement satisfies. That is what lets
 * a merchant advertise more than one.
 *
 * When none does, the reason comes from the quote the payment got FURTHEST
 * through, so a payer underpaying the second way to pay is told it underpaid
 * rather than told about the first way's instrument.
 */
export function selectQuote<TRequirements extends X402PaymentRequirements<unknown>>(
  echoed: TRequirements,
  quotes: Array<Quote<TRequirements>>,
  rules: RuleTable,
): string | undefined {
  let furthest: { reason: string; depth: number } | undefined;
  for (const quote of quotes) {
    const result = compareQuote(
      echoed as unknown as Record<string, unknown>,
      quote.requirements as unknown as Record<string, unknown>,
      rules,
    );
    if (result.ok) return undefined;
    if (!furthest || result.depth > furthest.depth) {
      furthest = { reason: result.reason, depth: result.depth };
    }
  }
  // buildQuotes never returns an empty list, so `furthest` is always set.
  return furthest?.reason ?? "policy_requirements_invalid";
}
