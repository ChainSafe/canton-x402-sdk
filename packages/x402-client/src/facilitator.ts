import type {
  CantonPaymentPayload,
  CantonPaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyRequest,
  VerifyResponse,
} from "@chainsafe/x402-core";

export interface FacilitatorClientOptions {
  /**
   * API key identifying the caller to the facilitator's /v2/verify and /v2/settle
   * (a hosted facilitator matches its sha256 against a registered merchant). Sent
   * as `Authorization: Bearer <apiKey>`. A string or an async getter.
   */
  apiKey: string | (() => string | Promise<string>);
  /** Abort a request that exceeds this many ms. Omit for no timeout. */
  timeoutMs?: number;
}

/**
 * A facilitator call that did not yield a domain response: a `4xx`/`5xx` (bad
 * request, unauthorized, rate-limited, internal error) or a transport/network
 * failure. An *evaluated-but-invalid* payment is NOT this — the facilitator
 * returns `200` with `{isValid:false}` / `{success:false}` for those, so they
 * come back as normal `VerifyResponse` / `SettleResponse` values.
 */
export class FacilitatorError extends Error {
  constructor(
    /** The endpoint path, e.g. `/v2/verify`. */
    readonly endpoint: string,
    /** HTTP status, or `0` for a network/timeout failure (no response). */
    readonly status: number,
    /** Parsed JSON error body if any, else the raw text, else `undefined`. */
    readonly body: unknown,
    /** Seconds parsed from a `Retry-After` header (e.g. on a 429), if present. */
    readonly retryAfter?: number,
    options?: { cause?: unknown },
  ) {
    super(`facilitator ${endpoint} failed (${status || "network error"})`, options);
    this.name = "FacilitatorError";
  }
}

interface RawResponse {
  ok: boolean;
  status: number;
  parsed: unknown;
  text: string;
  retryAfter?: number;
}

/** Thin client for a Canton x402 facilitator's verify / settle / supported API. */
export class FacilitatorClient {
  private readonly base: string;

  /**
   * @param facilitatorUrl Base URL of the facilitator; a trailing slash is trimmed.
   * @param opts Required API key, plus an optional request timeout.
   */
  constructor(
    facilitatorUrl: string,
    private readonly opts: FacilitatorClientOptions,
  ) {
    this.base = facilitatorUrl.replace(/\/$/, "");
  }

  /**
   * POST /v2/verify — dry-run validation without settling. Resolves with the
   * verdict (`isValid` true or false); throws {@link FacilitatorError} only on a
   * protocol/transport error.
   */
  verify(
    payload: CantonPaymentPayload,
    requirements: CantonPaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.postDomain<VerifyResponse>("/v2/verify", envelope(payload, requirements));
  }

  /**
   * POST /v2/settle — execute the prepared transfer on-ledger. Resolves with the
   * outcome (`success` true or false); throws {@link FacilitatorError} only on a
   * protocol/transport error.
   */
  settle(
    payload: CantonPaymentPayload,
    requirements: CantonPaymentRequirements,
  ): Promise<SettleResponse> {
    return this.postDomain<SettleResponse>("/v2/settle", envelope(payload, requirements));
  }

  /** GET /v2/supported — the (scheme, network) kinds this facilitator accepts. */
  async supported(): Promise<SupportedResponse> {
    const res = await this.request("/v2/supported", "GET");
    if (res.ok && res.parsed !== undefined) return res.parsed as SupportedResponse;
    throw this.error("/v2/supported", res);
  }

  /**
   * Shared POST path for verify/settle: send the envelope and return the domain
   * response on 2xx, or throw {@link FacilitatorError} on anything else.
   */
  private async postDomain<T>(path: string, body: VerifyRequest): Promise<T> {
    const res = await this.request(path, "POST", JSON.stringify(body));
    // 2xx is the only success path: the facilitator returns evaluated verdicts
    // (valid AND invalid) with 200. Any non-2xx is a protocol/server error whose
    // body isn't a valid domain response — surface it as a typed error, never as
    // a fabricated VerifyResponse/SettleResponse.
    if (res.ok && res.parsed !== undefined) return res.parsed as T;
    throw this.error(path, res);
  }

  /**
   * Perform one HTTP request and normalize the result into a {@link RawResponse}.
   * Every failure mode — no response, a failed body read — is converted into a
   * {@link FacilitatorError}, so callers never see a raw fetch rejection.
   */
  private async request(path: string, method: string, jsonBody?: string): Promise<RawResponse> {
    const headers: Record<string, string> = await this.authHeaders();
    if (jsonBody !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: jsonBody,
        signal: this.opts.timeoutMs ? AbortSignal.timeout(this.opts.timeoutMs) : undefined,
      });
    } catch (cause) {
      // No HTTP response at all — DNS/connection failure, or an aborted timeout.
      throw new FacilitatorError(path, 0, undefined, undefined, { cause });
    }
    // The response arrived, but its body is still streaming — reading it can fail
    // (connection dropped mid-body, or the timeout fires during the read). Keep
    // the status we already have, but stay within the FacilitatorError contract.
    let text: string;
    try {
      text = await res.text();
    } catch (cause) {
      throw new FacilitatorError(path, res.status, undefined, undefined, { cause });
    }
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return {
      ok: res.ok,
      status: res.status,
      parsed,
      text,
      retryAfter: parseRetryAfter(res.headers.get("retry-after")),
    };
  }

  /** Build a {@link FacilitatorError} from a non-domain response (parsed body preferred over raw text). */
  private error(path: string, res: RawResponse): FacilitatorError {
    return new FacilitatorError(path, res.status, res.parsed ?? res.text, res.retryAfter);
  }

  /** Resolve the configured API key (static or async) into an `Authorization` header. */
  private async authHeaders(): Promise<Record<string, string>> {
    const { apiKey } = this.opts;
    const resolved = typeof apiKey === "function" ? await apiKey() : apiKey;
    return { Authorization: `Bearer ${resolved}` };
  }
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into seconds. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, Math.round((when - Date.now()) / 1000));
}

/** Wrap a payload + requirements into the `{x402Version, paymentPayload, paymentRequirements}` wire envelope. */
function envelope(
  payload: CantonPaymentPayload,
  requirements: CantonPaymentRequirements,
): VerifyRequest {
  return {
    x402Version: payload.x402Version,
    paymentPayload: payload,
    paymentRequirements: requirements,
  };
}
