// Pure (scheme, network) → SchemeVerifier dispatch. Mirrors the facilitator's
// `findScheme`: a payment is routed to the verifier registered for its
// requirements' exact (scheme, network) pair. An unregistered pair verifies as
// `unsupported_scheme`, or `invalid_network` when the scheme is registered on
// other networks (spec Rule 1). Routing reads the requirements, not the payer's
// `accepted`, so a malformed payment reaches its verifier and gets its specific
// verdict.
// Adding a scheme is "register another SchemeVerifier" — no change here.

import type { NetworkId } from "../types/common";
import type { SchemeVerifier, VerifyResponse } from "../types/facilitator";
import type { X402PaymentPayload } from "../types/payment";
import type { X402PaymentRequirements } from "../types/requirements";

export interface VerifierRegistry {
  /** The verifier registered for this exact (scheme, network), or undefined. */
  find(scheme: string, network: NetworkId): SchemeVerifier | undefined;
  /**
   * Dispatch a payment to the verifier for its requirements; `unsupported_scheme`
   * or `invalid_network` if none. `context` is passed through untouched — see
   * {@link SchemeVerifier.verify}, which says what a scheme expects in it. The
   * registry is heterogeneous, so it cannot know the shape; the caller builds
   * the one the requirements' scheme asks for.
   */
  verify(
    payload: X402PaymentPayload<unknown, unknown>,
    requirements: X402PaymentRequirements<unknown>,
    context: unknown,
  ): Promise<VerifyResponse>;
}

// NUL separates the composite key so it can't collide with a scheme or network
// that happens to contain the delimiter. Written as the ESCAPE `\x00`, never as
// a literal NUL byte: one in the source makes git, grep, ripgrep and GitHub's
// diff treat this file as binary, so reviewers see "binary file not shown" and
// text searches skip it silently.
const keyOf = (scheme: string, network: string): string => `${scheme}\x00${network}`;

/**
 * Build a dispatcher over a fixed set of verifiers. Last registration for a given
 * (scheme, network) wins, matching a plain `Map` insertion.
 */
export function createVerifierRegistry(verifiers: readonly SchemeVerifier[]): VerifierRegistry {
  const map = new Map<string, SchemeVerifier>();
  for (const v of verifiers) map.set(keyOf(v.schemeId, v.networkId), v);
  const schemes = new Set(verifiers.map((v) => v.schemeId));

  return {
    find(scheme, network) {
      return map.get(keyOf(scheme, network));
    },
    async verify(payload, requirements, context) {
      const verifier = map.get(keyOf(requirements.scheme, requirements.network));
      if (!verifier) {
        // Nothing to put in `extensions`: the code is the whole answer.
        const invalidReason = schemes.has(requirements.scheme) ? "invalid_network" : "unsupported_scheme";
        return { isValid: false, invalidReason };
      }
      return verifier.verify(payload, requirements, context);
    },
  };
}
