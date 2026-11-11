// The seam between the middleware and a payment scheme.
//
// The middleware owns the HTTP flow — when a challenge is issued, which quote a
// payment is for, what is sent to the facilitator, what each failure answers —
// and the x402 v2 fields every scheme shares. A scheme owns `extra`: what goes
// in it, how an echoed one is held against the merchant's own, and where a
// per-challenge reference lives inside it.
//
// SPDX-License-Identifier: Apache-2.0

import type { Request } from "express";
import {
  isValidAmount,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from "@chainsafe/x402-core";
import type { FacilitatorClient } from "@chainsafe/x402-client";

/** A fixed value, or one computed per request. */
export type Resolvable<T> = T | ((req: Request) => T | Promise<T>);

/** Resolve a {@link Resolvable}: call it with the request if it's a function, else return it. */
export async function resolve<T>(value: Resolvable<T>, req: Request): Promise<T> {
  return typeof value === "function" ? (value as (req: Request) => T | Promise<T>)(req) : value;
}

/**
 * The fields that describe the sale rather than one way of paying for it.
 *
 * Named once for all the ways to pay, and all but `resource` and `description`
 * may be overridden per entry. Those two cannot: x402 v2 §5.1.2 puts `resource`
 * on the 402 itself rather than on each `accepts[]` entry, so entries
 * disagreeing about it would make the envelope describe one sale and its
 * entries another.
 */
export interface SharedTerms {
  /** Merchant party receiving payment. */
  payTo: Resolvable<string>;
  /**
   * Network id — on Canton a `canton:<name>` from x402-core's networks.
   *
   * Optional when the scheme can discover it; see the scheme's own spec.
   */
  network?: Resolvable<string>;
  /** Scheme id. Defaults to the scheme adapter's own id. */
  scheme?: Resolvable<string>;
  /** Resource URL. Default: the request's absolute URL. */
  resource?: Resolvable<string>;
  /** Human description. Default: `Access to <path>`. */
  description?: Resolvable<string>;
  /**
   * Seconds the client has to complete payment. Default 60. Compared: the
   * facilitator holds a payment for at most this long, and a payer echoing a
   * longer one is refused with `policy_timeout`.
   */
  maxTimeoutSeconds?: Resolvable<number>;
}

/**
 * What a scheme adapter is handed: the shared terms with one way to pay merged
 * in. A scheme's own spec extends this with whatever its `extra` needs.
 */
export interface BaseRequirementsSpec extends SharedTerms {
  /**
   * Price in **atomic units**, as an integer string: 1 CC = 1e10, so
   * `"500000000"` is 0.05 CC. The same unit the wire carries — the middleware
   * does not convert, so a price means the same thing here as in a builder or
   * in an echoed requirement.
   */
  amount: Resolvable<string>;
}

/* ------------------------------------------------------------------ *
 * Holding an echoed requirement against the merchant's own terms
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * The adapter
 * ------------------------------------------------------------------ */

/** What a scheme is handed when it builds a quote. */
export interface SchemeContext {
  /** For a scheme that discovers its terms from `GET /v2/supported`. */
  facilitator: FacilitatorClient;
}

/** The scheme's own part of a quote. */
export interface SchemeQuote {
  /** Scheme id to advertise. */
  scheme: string;
  /** Network id to advertise — the scheme's, when the merchant left it out. */
  network: string;
  /** Display symbol for `asset`. */
  asset: string;
  /** The scheme-defined `extra`, with no per-challenge reference in it yet. */
  extra: Record<string, unknown>;
  /**
   * Mint this quote's per-challenge merchant reference, returning the `extra`
   * fields that carry it. Called only when a challenge is ISSUED, so a scheme
   * may do something recordable in here. Absent when the quote carries none.
   */
  mintReference?: () => Promise<Record<string, unknown>>;
  /**
   * Which quotes share one reference, compared by identity.
   *
   * A 402 is one sale with several ways to pay, so entries inheriting the
   * merchant's one generator must be issued one reference between them — a
   * generator that books an order would otherwise book one per entry and be
   * paid for one. Entries naming different generators get different keys, and
   * so a reference each.
   *
   * Absent means "nothing to share with": this quote mints its own.
   */
  referenceKey?: unknown;
}

/**
 * Everything about a payment scheme the middleware cannot know.
 *
 * `TSpec` is the merchant-facing spec, `TRequirements` and `TPayload` the
 * concrete wire shapes this scheme accepts. The middleware stays generic over
 * all three and narrows through {@link acceptsRequirements} and
 * {@link acceptsPayload}, which are the only things that have checked a header
 * someone else sent.
 */
export interface SchemeAdapter<
  TSpec extends BaseRequirementsSpec,
  TRequirements extends X402PaymentRequirements<unknown>,
  TPayload extends X402PaymentPayload<unknown>,
> {
  /** Scheme id, e.g. `exact`. Used as the default for `spec.scheme`. */
  readonly id: string;
  /** Does this echoed requirement conform to the scheme? */
  acceptsRequirements(
    requirements: X402PaymentRequirements<unknown>,
  ): requirements is TRequirements;
  /** Does this payload conform to the scheme? */
  acceptsPayload(payload: X402PaymentPayload<unknown>): payload is TPayload;
  /**
   * Who paid, read from the payload itself — for when the facilitator does not
   * say. `payer` is optional in a verify response, and the x402 v2 payload
   * names no payer, so whoever it is has to be recovered from what the payer
   * signed. Only the scheme knows how: canton-exact decodes the prepared
   * transaction and takes its sender. `undefined` when it cannot be read.
   */
  payerOf(payload: TPayload): string | undefined;
  /**
   * What makes this entry a distinct way to pay, for the check that a route
   * offers no two of the same. `undefined` when the spec cannot say without a
   * request — a resolver-valued field — and the entry is then not checked.
   */
  distinctKey?(spec: TSpec): string | undefined;
  /**
   * The error code to refuse with when neither the facilitator nor
   * {@link SchemeAdapter.payerOf} can name the payer. The scheme's, because the
   * spec's codes are per-scheme: canton-exact answers
   * `invalid_exact_canton_malformed_payload`, and another scheme has its own.
   * Defaults to the protocol-level `transfer_mismatch`.
   */
  unreadablePayerReason?: string;
  /**
   * How each field of the scheme's `extra` is held against the merchant's.
   * Key it off the scheme's own schema so the table cannot drift from the shape
   * it describes.
   */
  readonly extraRules: RuleTable;
  /** Build the scheme's part of a quote from the merchant's spec. */
  quote(req: Request, spec: TSpec, ctx: SchemeContext): Promise<SchemeQuote>;
}
