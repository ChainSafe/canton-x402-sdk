import { describe, it, expect, vi, beforeEach } from "vitest";
import { paymentRequired } from "../middleware/express.js";

// Minimal Express-like request/response mocks
function mockReq(headers: Record<string, string> = {}): Record<string, unknown> {
  return {
    headers,
    originalUrl: "/api/resource",
  };
}

function mockRes(): Record<string, unknown> & { _status: number; _json: unknown; _headers: Record<string, string> } {
  const res = {
    _status: 0,
    _json: null as unknown,
    _headers: {} as Record<string, string>,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: unknown) {
      res._json = body;
      return res;
    },
    setHeader(key: string, value: string) {
      res._headers[key] = value;
    },
  };
  return res;
}

describe("paymentRequired middleware", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  it("returns 402 when no X-PAYMENT header", async () => {
    const middleware = paymentRequired({
      payTo: "merchant::1220abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      amount: "1.00",
      facilitatorUrl: "http://localhost:3000",
    });

    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await middleware(req as any, res as any, next);

    expect(res._status).toBe(402);
    expect((res._json as Record<string, unknown>).error).toBe("Payment Required");
    expect((res._json as Record<string, unknown>).x402Version).toBe(1);
    expect(res._headers["X-PAYMENT-REQUIRED"]).toBeDefined();
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 402 requirements with correct scheme and network", async () => {
    const middleware = paymentRequired({
      payTo: "merchant::1220abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      amount: "2.50",
      network: "canton-devnet",
      asset: "CC",
      facilitatorUrl: "http://localhost:3000",
      description: "Premium content",
    });

    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await middleware(req as any, res as any, next);

    expect(res._status).toBe(402);
    const body = res._json as { accepts: Array<Record<string, unknown>> };
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0].scheme).toBe("exact-canton");
    expect(body.accepts[0].network).toBe("canton-devnet");
    expect(body.accepts[0].maxAmountRequired).toBe("2.50");
    expect(body.accepts[0].description).toBe("Premium content");
  });

  it("returns 402 on malformed X-PAYMENT header", async () => {
    const middleware = paymentRequired({
      payTo: "merchant::1220abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      amount: "1.00",
      facilitatorUrl: "http://localhost:3000",
    });

    const req = mockReq({ "x-payment": "not-valid-base64!!!" });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req as any, res as any, next);

    expect(res._status).toBe(402);
    expect((res._json as Record<string, unknown>).error).toContain(
      "Invalid X-PAYMENT header",
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() on valid payment verification", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          isValid: true,
          payer: "payer::12201234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        }),
    });

    const middleware = paymentRequired({
      payTo: "merchant::1220abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      amount: "1.00",
      facilitatorUrl: "http://localhost:3000",
    });

    const paymentPayload = {
      x402Version: 1,
      scheme: "exact-canton",
      network: "canton-local",
      payload: {
        command: {
          payer: "payer::12201234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
          payee: "merchant::1220abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
          amount: "1.00",
          currency: "CC",
          resourceId: "/api/resource",
          nonce: "test-nonce",
        },
      },
    };

    const encoded = Buffer.from(JSON.stringify(paymentPayload)).toString(
      "base64",
    );
    const req = mockReq({ "x-payment": encoded });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req as any, res as any, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((req as Record<string, unknown>).x402).toBeDefined();
  });

  it("returns 402 when facilitator says payment invalid", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          isValid: false,
          invalidReason: "insufficient_amount",
        }),
    });

    const middleware = paymentRequired({
      payTo: "merchant::1220abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      amount: "1.00",
      facilitatorUrl: "http://localhost:3000",
    });

    const paymentPayload = {
      x402Version: 1,
      scheme: "exact-canton",
      network: "canton-local",
      payload: { command: { payer: "test", payee: "test", amount: "0.50", currency: "CC", resourceId: "/api/resource", nonce: "n" } },
    };
    const encoded = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const req = mockReq({ "x-payment": encoded });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req as any, res as any, next);

    expect(res._status).toBe(402);
    expect((res._json as Record<string, unknown>).error).toContain(
      "insufficient_amount",
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 402 when facilitator endpoint fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal error"),
    });

    const middleware = paymentRequired({
      payTo: "merchant::1220abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      amount: "1.00",
      facilitatorUrl: "http://localhost:3000",
    });

    const paymentPayload = {
      x402Version: 1,
      scheme: "exact-canton",
      network: "canton-local",
      payload: { command: { payer: "test", payee: "test", amount: "1.00", currency: "CC", resourceId: "/api/resource", nonce: "n" } },
    };
    const encoded = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const req = mockReq({ "x-payment": encoded });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req as any, res as any, next);

    expect(res._status).toBe(402);
    expect((res._json as Record<string, unknown>).error).toContain(
      "verification failed",
    );
  });

  it("uses getPrice function when provided", async () => {
    const middleware = paymentRequired({
      payTo: "merchant::1220abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      amount: "1.00",
      facilitatorUrl: "http://localhost:3000",
      getPrice: () => "5.00",
    });

    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await middleware(req as any, res as any, next);

    expect(res._status).toBe(402);
    const body = res._json as { accepts: Array<Record<string, unknown>> };
    expect(body.accepts[0].maxAmountRequired).toBe("5.00");
  });
});
