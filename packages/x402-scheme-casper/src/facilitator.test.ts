import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CASPER_TESTNET_NETWORK,
  CasperFacilitatorClient,
  CasperFacilitatorError,
  DEFAULT_CASPER_FACILITATOR_URL,
  wcsprAsset,
} from "./index";
import type { CasperPaymentPayload, CasperPaymentRequirements } from "./index";

const requirements: CasperPaymentRequirements = {
  scheme: "exact",
  network: CASPER_TESTNET_NETWORK,
  maxAmountRequired: "1000000000",
  asset: wcsprAsset("hash-" + "ab".repeat(32)),
  payTo: "account-hash-" + "cd".repeat(32),
  resource: "/api/resource",
  nonce: "550e8400-e29b-41d4-a716-446655440000",
  validBefore: "2999-01-01T00:00:00.000Z",
};

const payload: CasperPaymentPayload = {
  x402Version: 2,
  scheme: "exact",
  network: CASPER_TESTNET_NETWORK,
  payload: {
    signature: "ab".repeat(64),
    publicKey: "01" + "ef".repeat(32),
    authorization: {
      from: "account-hash-" + "12".repeat(32),
      to: requirements.payTo,
      value: "1000000000",
      validAfter: "0",
      validBefore: "99999999999",
      nonce: "0x" + "34".repeat(32),
    },
  },
};

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CasperFacilitatorClient.verify", () => {
  it("POSTs the x402 envelope to /verify and returns a valid verdict", async () => {
    const fn = mockFetch(200, { isValid: true, payer: payload.payload.authorization.from });
    const client = new CasperFacilitatorClient("https://facilitator.example/");

    const res = await client.verify(payload, requirements);

    expect(res).toEqual({ isValid: true, payer: payload.payload.authorization.from });
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://facilitator.example/verify");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements: requirements,
    });
  });

  it("returns an evaluated-but-invalid verdict without throwing", async () => {
    mockFetch(200, { isValid: false, invalidReason: "bad_signature" });
    const client = new CasperFacilitatorClient("https://facilitator.example");

    await expect(client.verify(payload, requirements)).resolves.toEqual({
      isValid: false,
      invalidReason: "bad_signature",
    });
  });

  it("throws CasperFacilitatorError on a non-2xx response", async () => {
    mockFetch(503, { error: "unavailable" });
    const client = new CasperFacilitatorClient("https://facilitator.example");

    const err = await client.verify(payload, requirements).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CasperFacilitatorError);
    expect((err as CasperFacilitatorError).status).toBe(503);
    expect((err as CasperFacilitatorError).endpoint).toBe("/verify");
  });

  it("throws CasperFacilitatorError with status 0 on a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const client = new CasperFacilitatorClient("https://facilitator.example");

    const err = await client.verify(payload, requirements).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CasperFacilitatorError);
    expect((err as CasperFacilitatorError).status).toBe(0);
  });
});

describe("CasperFacilitatorClient.settle", () => {
  it("POSTs to /settle and returns a successful settlement", async () => {
    const fn = mockFetch(200, {
      success: true,
      network: CASPER_TESTNET_NETWORK,
      transaction: "deploy-" + "aa".repeat(16),
      payer: payload.payload.authorization.from,
    });
    const client = new CasperFacilitatorClient();

    const res = await client.settle(payload, requirements);

    expect(res).toMatchObject({ success: true, network: CASPER_TESTNET_NETWORK });
    const [url] = fn.mock.calls[0] as [string];
    expect(url).toBe(`${DEFAULT_CASPER_FACILITATOR_URL}/settle`);
  });

  it("returns an evaluated settlement failure without throwing", async () => {
    mockFetch(200, { success: false, errorReason: "execution_failed" });
    const client = new CasperFacilitatorClient("https://facilitator.example");

    await expect(client.settle(payload, requirements)).resolves.toEqual({
      success: false,
      errorReason: "execution_failed",
    });
  });

  it("sends the API key as a bearer token", async () => {
    const fn = mockFetch(200, { success: false, errorReason: "unauthorized" });
    const client = new CasperFacilitatorClient("https://facilitator.example", {
      apiKey: () => "secret-key",
    });

    await client.settle(payload, requirements);

    const [, init] = fn.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-key");
  });
});
