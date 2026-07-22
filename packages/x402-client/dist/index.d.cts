import { CantonPaymentPayload, CantonPaymentRequirements, VerifyResponse, SettleResponse, SupportedResponse } from '@chainsafe/x402-core';

interface FacilitatorClientOptions {
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
declare class FacilitatorError extends Error {
    /** The endpoint path, e.g. `/v2/verify`. */
    readonly endpoint: string;
    /** HTTP status, or `0` for a network/timeout failure (no response). */
    readonly status: number;
    /** Parsed JSON error body if any, else the raw text, else `undefined`. */
    readonly body: unknown;
    /** Seconds parsed from a `Retry-After` header (e.g. on a 429), if present. */
    readonly retryAfter?: number | undefined;
    constructor(
    /** The endpoint path, e.g. `/v2/verify`. */
    endpoint: string, 
    /** HTTP status, or `0` for a network/timeout failure (no response). */
    status: number, 
    /** Parsed JSON error body if any, else the raw text, else `undefined`. */
    body: unknown, 
    /** Seconds parsed from a `Retry-After` header (e.g. on a 429), if present. */
    retryAfter?: number | undefined, options?: {
        cause?: unknown;
    });
}
/** Thin client for a Canton x402 facilitator's verify / settle / supported API. */
declare class FacilitatorClient {
    private readonly opts;
    private readonly base;
    /**
     * @param facilitatorUrl Base URL of the facilitator; a trailing slash is trimmed.
     * @param opts Required API key, plus an optional request timeout.
     */
    constructor(facilitatorUrl: string, opts: FacilitatorClientOptions);
    /**
     * POST /v2/verify — dry-run validation without settling. Resolves with the
     * verdict (`isValid` true or false); throws {@link FacilitatorError} only on a
     * protocol/transport error.
     */
    verify(payload: CantonPaymentPayload, requirements: CantonPaymentRequirements): Promise<VerifyResponse>;
    /**
     * POST /v2/settle — execute the prepared transfer on-ledger. Resolves with the
     * outcome (`success` true or false); throws {@link FacilitatorError} only on a
     * protocol/transport error.
     */
    settle(payload: CantonPaymentPayload, requirements: CantonPaymentRequirements): Promise<SettleResponse>;
    /** GET /v2/supported — the (scheme, network) kinds this facilitator accepts. */
    supported(): Promise<SupportedResponse>;
    /**
     * Shared POST path for verify/settle: send the envelope and return the domain
     * response on 2xx, or throw {@link FacilitatorError} on anything else.
     */
    private postDomain;
    /**
     * Perform one HTTP request and normalize the result into a {@link RawResponse}.
     * Every failure mode — no response, a failed body read — is converted into a
     * {@link FacilitatorError}, so callers never see a raw fetch rejection.
     */
    private request;
    /** Build a {@link FacilitatorError} from a non-domain response (parsed body preferred over raw text). */
    private error;
    /** Resolve the configured API key (static or async) into an `Authorization` header. */
    private authHeaders;
}

/**
 * @chainsafe/x402-client
 *
 * Chain-agnostic client for a Canton x402 facilitator. Speaks only the x402 wire
 * protocol (verify / settle / supported over the envelopes from @chainsafe/x402-core),
 * so any payer — the server SDK, a browser fetch wrapper, other tooling — reuses it.
 */
declare const VERSION = "0.0.1";

export { FacilitatorClient, type FacilitatorClientOptions, FacilitatorError, VERSION };
