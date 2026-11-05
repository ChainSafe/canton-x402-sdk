// Facilitator client for the Casper x402 facilitator
// (e.g. https://x402-facilitator.cspr.cloud) — POST /verify and POST /settle
// per x402 v2. Same envelope discipline as @chainsafe/x402-client's
// FacilitatorClient: 2xx bodies are domain verdicts (valid AND invalid);
// anything else surfaces as a typed CasperFacilitatorError, never a fabricated
// verdict.

import type { SettleResponse, VerifyResponse, X402Request } from "@chainsafe/x402-core";
import type {
  CasperAssetSpec,
  CasperPaymentInner,
  CasperPaymentPayload,
  CasperPaymentRequirements,
} from "./types";

/** Default hosted facilitator for the Casper Network. */
export const DEFAULT_CASPER_FACILITATOR_URL = "https://x402-facilitator.cspr.cloud";

/** exact/casper verify/settle request envelope. */
export type CasperX402Request = X402Request<CasperPaymentInner, CasperAssetSpec>;

export interface CasperFacilitatorClientOptions {
  /** Optional API key, sent as `Authorization: Bearer <apiKey>` when set. */
  apiKey?: string | (() => string | Promise<string>);
  /** Abort a request that exceeds this many ms. Omit for no timeout. */
  timeoutMs?: number;
}

/**
 * A facilitator call that did not yield a domain response: a `4xx`/`5xx` or a
 * transport/network failure. An *evaluated-but-invalid* payment is NOT this —
 * the facilitator returns `200` with `{isValid:false}` / `{success:false}`.
 */
export class CasperFacilitatorError extends Error {
  constructor(
    /** The endpoint path, e.g. `/verify`. */
    readonly endpoint: string,
    /** HTTP status, or `0` for a network/timeout failure (no response). */
    readonly status: number,
    /** Parsed JSON error body if any, else the raw text, else `undefined`. */
    readonly body: unknown,
    options?: { cause?: unknown },
  ) {
    super(`casper facilitator ${endpoint} failed (${status || "network error"})`, options);
    this.name = "CasperFacilitatorError";
  }
}

/** Thin client for a Casper x402 facilitator's verify / settle API. */
export class CasperFacilitatorClient {
  private readonly base: string;

  /**
   * @param facilitatorUrl Base URL of the facilitator; a trailing slash is
   *   trimmed. Defaults to {@link DEFAULT_CASPER_FACILITATOR_URL}.
   * @param opts Optional API key + request timeout.
   */
  constructor(
    facilitatorUrl: string = DEFAULT_CASPER_FACILITATOR_URL,
    private readonly opts: CasperFacilitatorClientOptions = {},
  ) {
    this.base = facilitatorUrl.replace(/\/$/, "");
  }

  /**
   * POST /verify — dry-run validation without settling. Resolves with the
   * verdict (`isValid` true or false); throws {@link CasperFacilitatorError}
   * only on a protocol/transport error.
   */
  verify(
    payload: CasperPaymentPayload,
    requirements: CasperPaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.postDomain<VerifyResponse>("/verify", envelope(payload, requirements));
  }

  /**
   * POST /settle — submit the CEP-18 `transfer_with_authorization` on-chain.
   * Resolves with the outcome (`success` true or false); throws
   * {@link CasperFacilitatorError} only on a protocol/transport error.
   */
  settle(
    payload: CasperPaymentPayload,
    requirements: CasperPaymentRequirements,
  ): Promise<SettleResponse> {
    return this.postDomain<SettleResponse>("/settle", envelope(payload, requirements));
  }

  private async postDomain<T>(path: string, body: CasperX402Request): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(await this.authHeaders()),
    };
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: this.opts.timeoutMs ? AbortSignal.timeout(this.opts.timeoutMs) : undefined,
      });
    } catch (cause) {
      throw new CasperFacilitatorError(path, 0, undefined, { cause });
    }
    let text: string;
    try {
      text = await res.text();
    } catch (cause) {
      throw new CasperFacilitatorError(path, res.status, undefined, { cause });
    }
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (res.ok && parsed !== undefined) return parsed as T;
    throw new CasperFacilitatorError(path, res.status, parsed ?? text);
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const { apiKey } = this.opts;
    const resolved = typeof apiKey === "function" ? await apiKey() : apiKey;
    return resolved ? { Authorization: `Bearer ${resolved}` } : {};
  }
}

/** Wrap a payload + requirements into the `{x402Version, paymentPayload, paymentRequirements}` wire envelope. */
function envelope(
  payload: CasperPaymentPayload,
  requirements: CasperPaymentRequirements,
): CasperX402Request {
  return {
    x402Version: payload.x402Version,
    paymentPayload: payload,
    paymentRequirements: requirements,
  };
}
