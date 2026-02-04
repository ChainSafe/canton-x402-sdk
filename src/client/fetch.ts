// Canton x402 SDK -- Client Fetch Wrapper

import type {
  X402FetchOptions,
  PaymentRequirements,
  PaymentPayload,
  CantonSdkConfig,
} from "../types.js";
import { InsufficientBalanceError } from "../types.js";
import { createAuthProvider } from "../canton/auth.js";
import { CantonJsonClient } from "../canton/json-client.js";
import { settleLocal, settle } from "../canton/settle.js";
import { randomUUID } from "crypto";

// ─── Caching & Circuit Breaker ────────────────────────────────────────────

class BalanceCache {
  private holdings: string[] | null = null;
  private lastCheck = 0;
  constructor(private ttlMs = 30_000) {}

  get(): string[] | null {
    if (Date.now() - this.lastCheck > this.ttlMs) return null;
    return this.holdings;
  }

  set(holdings: string[]) {
    this.holdings = holdings;
    this.lastCheck = Date.now();
  }

  invalidate() {
    this.lastCheck = 0;
  }
}

class RequirementsCache {
  private cache = new Map<string, PaymentRequirements>();

  get(url: string): PaymentRequirements | undefined {
    const key = new URL(url).pathname;
    return this.cache.get(key);
  }

  set(url: string, requirements: PaymentRequirements) {
    const key = new URL(url).pathname;
    this.cache.set(key, requirements);
  }
}

class CircuitBreaker {
  private failures = 0;
  private trippedAt = 0;
  constructor(private threshold = 2, private cooldownMs = 60_000) {}

  record() { this.failures++; this.trippedAt = Date.now(); }
  reset() { this.failures = 0; }

  isTripped(): boolean {
    if (this.failures < this.threshold) return false;
    if (Date.now() - this.trippedAt > this.cooldownMs) {
      this.reset();
      return false;
    }
    return true;
  }
}

// ─── Fetch Wrapper ────────────────────────────────────────────────────────

/**
 * Create a fetch-compatible function that automatically handles 402 responses.
 *
 * Three optimization layers reduce round-trips for repeat calls:
 *
 * 1. **Balance cache** — caches `getPayerHoldings` result (~30s TTL).
 *    If balance is known-zero, throws `InsufficientBalanceError` immediately
 *    with zero network calls.
 *
 * 2. **Requirements cache** — after the first 402 for a URL path, caches the
 *    `PaymentRequirements`. Subsequent calls skip the discovery request and
 *    go straight to settle + paid request (saves 1 round-trip).
 *
 * 3. **Circuit breaker** — after N consecutive settlement failures (default 2),
 *    short-circuits all calls for a cooldown period (default 60s). Resets on
 *    successful settlement or after cooldown expires.
 */
export function createX402Fetch(options: X402FetchOptions) {
  const auth = createAuthProvider(options.config.auth);
  const client = new CantonJsonClient(options.config.ledgerApiUrl, auth);

  const balanceCache = new BalanceCache();
  const requirementsCache = new RequirementsCache();
  const circuitBreaker = new CircuitBreaker();

  return async (
    url: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const urlStr = url.toString();

    // ── Layer 3: Circuit breaker ──────────────────────────────────────
    if (circuitBreaker.isTripped()) {
      throw new InsufficientBalanceError(options.payerParty);
    }

    // ── Layer 1: Balance cache ────────────────────────────────────────
    const cachedBalance = balanceCache.get();
    if (cachedBalance !== null && cachedBalance.length === 0) {
      circuitBreaker.record();
      throw new InsufficientBalanceError(options.payerParty);
    }

    // ── Layer 2: Requirements cache ───────────────────────────────────
    let requirements = requirementsCache.get(urlStr);

    if (!requirements) {
      // Cache miss — make the initial request to discover requirements
      const response = await fetch(url, init);
      if (response.status !== 402) return response;

      const body = (await response.json()) as {
        x402Version?: number;
        accepts?: PaymentRequirements[];
      };

      requirements = body.accepts?.find(
        (r) => r.scheme === "exact-canton",
      );
      if (!requirements) {
        throw new Error(
          "Server returned 402 but no exact-canton payment scheme found",
        );
      }

      requirementsCache.set(urlStr, requirements);
    }

    console.log(
      `[x402] Payment required: ${requirements.maxAmountRequired} CC to ${requirements.payTo}`,
    );

    // ── Settle ────────────────────────────────────────────────────────
    const settleOpts = {
      payerParty: options.payerParty,
      payeeParty: requirements.payTo,
      amount: requirements.maxAmountRequired,
      resourceId: requirements.resource,
    };

    let settleResult;
    if (options.config.network === "canton-local") {
      settleResult = await settleLocal(settleOpts, options.config, client, auth);
    } else {
      if (!options.privateKey || !options.keyFingerprint) {
        throw new Error(
          "DevNet/MainNet settlement requires privateKey and keyFingerprint in X402FetchOptions",
        );
      }
      settleResult = await settle(
        { ...settleOpts, privateKey: options.privateKey, keyFingerprint: options.keyFingerprint },
        options.config,
        client,
        auth,
      );
    }

    if (!settleResult.success) {
      // Zero-balance → cache + trip breaker for fast subsequent failures
      if (settleResult.error?.includes("No Amulet holdings")) {
        balanceCache.set([]);
        circuitBreaker.record();
        throw new InsufficientBalanceError(
          options.payerParty,
          requirements.maxAmountRequired,
        );
      }
      throw new Error(`Settlement failed: ${settleResult.error}`);
    }

    // Settlement succeeded — reset protections
    circuitBreaker.reset();
    balanceCache.invalidate();

    console.log(
      `[x402] Payment settled: tx=${settleResult.transactionId}`,
    );

    // ── Build payment payload & retry ─────────────────────────────────
    const paymentPayload: PaymentPayload = {
      x402Version: 1,
      scheme: "exact-canton",
      network: options.config.network,
      payload: {
        command: {
          payer: options.payerParty,
          payee: requirements.payTo,
          amount: requirements.maxAmountRequired,
          currency: requirements.asset ?? "CC",
          resourceId: requirements.resource,
          nonce: randomUUID(),
          transactionId: settleResult.transactionId,
        },
      },
    };

    const paymentHeader = Buffer.from(
      JSON.stringify(paymentPayload),
    ).toString("base64");

    console.log(`[x402] Retrying request with payment proof...`);
    const retryInit: RequestInit = { ...init };
    retryInit.headers = {
      ...(init?.headers as Record<string, string>),
      "X-PAYMENT": paymentHeader,
    };

    return fetch(url, retryInit);
  };
}
