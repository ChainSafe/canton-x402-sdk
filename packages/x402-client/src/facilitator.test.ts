import { describe, it, expect, vi, afterEach } from "vitest";
import type { CantonPaymentPayload, CantonPaymentRequirements } from "@chainsafe/x402-core";
import { FacilitatorClient, FacilitatorError } from "./facilitator";

const payload = { x402Version: 2, scheme: "exact", network: "canton:x", payload: {} } as unknown as CantonPaymentPayload;
const requirements = { scheme: "exact", network: "canton:x", nonce: "n" } as unknown as CantonPaymentRequirements;

const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers });

describe("FacilitatorClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("verify posts the envelope and returns a valid verdict", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({ isValid: true, payer: "p" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new FacilitatorClient("https://f.example/", { apiKey: "k" });
    const res = await client.verify(payload, requirements);
    expect(res).toEqual({ isValid: true, payer: "p" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://f.example/v2/verify");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      x402Version: 2,
      paymentPayload: { scheme: "exact" },
      paymentRequirements: { nonce: "n" },
    });
  });

  it("returns an evaluated-but-invalid verdict (200 isValid:false) as a value", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ isValid: false, invalidReason: "bad_signature" })));
    const client = new FacilitatorClient("https://f.example", { apiKey: "k" });
    const res = await client.verify(payload, requirements);
    expect(res).toEqual({ isValid: false, invalidReason: "bad_signature" });
  });

  it("throws FacilitatorError on a 4xx protocol error, attaching status + body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ isValid: false, invalidReason: "bad_request", error: "malformed" }, 400)));
    const client = new FacilitatorClient("https://f.example", { apiKey: "k" });
    const err = await client.verify(payload, requirements).catch((e) => e);
    expect(err).toBeInstanceOf(FacilitatorError);
    expect(err.status).toBe(400);
    expect(err.endpoint).toBe("/v2/verify");
    expect(err.body).toMatchObject({ invalidReason: "bad_request" });
  });

  it("throws FacilitatorError with retryAfter on a 429", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "rate limited" }, 429, { "Retry-After": "30" })));
    const client = new FacilitatorClient("https://f.example", { apiKey: "k" });
    const err: FacilitatorError = await client.settle(payload, requirements).catch((e) => e);
    expect(err).toBeInstanceOf(FacilitatorError);
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(30);
  });

  it("throws FacilitatorError on a transport error with a non-JSON body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream boom", { status: 502 })));
    const client = new FacilitatorClient("https://f.example", { apiKey: "k" });
    const err: FacilitatorError = await client.verify(payload, requirements).catch((e) => e);
    expect(err).toBeInstanceOf(FacilitatorError);
    expect(err.status).toBe(502);
    expect(err.body).toBe("upstream boom");
  });

  it("wraps a network failure as FacilitatorError with status 0 and a cause", async () => {
    const boom = new Error("ECONNREFUSED");
    vi.stubGlobal("fetch", vi.fn(async () => { throw boom; }));
    const client = new FacilitatorClient("https://f.example", { apiKey: "k" });
    const err: FacilitatorError = await client.verify(payload, requirements).catch((e) => e);
    expect(err).toBeInstanceOf(FacilitatorError);
    expect(err.status).toBe(0);
    expect(err.cause).toBe(boom);
  });

  it("settle returns a success outcome", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ success: true, network: "canton:x", transaction: "upd1", payer: "p" })));
    const client = new FacilitatorClient("https://f.example", { apiKey: "k" });
    const res = await client.settle(payload, requirements);
    expect(res).toMatchObject({ success: true, transaction: "upd1" });
  });

  it("sends the api key as a bearer header from an async getter", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({ kinds: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new FacilitatorClient("https://f.example", { apiKey: async () => "tok-123" });
    await client.supported();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://f.example/v2/supported");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer tok-123" });
  });
});
