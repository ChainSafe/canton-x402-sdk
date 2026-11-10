import { describe, it, expect, vi } from "vitest";
import {
  encodePaymentHeader,
  type CantonPaymentPayload,
  type CantonPaymentRequirements,
} from "@chainsafe/x402-core";
import { createX402Fetch, type FetchLike } from "./fetch";
import type { X402Payer } from "./payer";

const requirements = {
  scheme: "exact",
  network: "canton:x",
  amount: "500000000",
  asset: "CC",
  extra: { assetTransferMethod: "transfer-factory", executeBeforeSeconds: 120, instrumentId: { id: "Amulet", admin: "DSO::x" } },
  payTo: "merchant::x",
  resource: "https://api.example/paid",
  maxTimeoutSeconds: 60,
} as CantonPaymentRequirements;

const payload = {
  x402Version: 2,
  accepted: requirements,
  payload: {
    assetTransferMethod: "transfer-factory",
    preparedTransaction: "cHJlcA==",
    preparedTxHash: "deadbeef",
    signature: "cafe",
    publicKey: "cGs=",
    hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
  },
} as unknown as CantonPaymentPayload;

function makePayer(supports = true) {
  return { supports: () => supports, authorize: vi.fn(async () => payload) } satisfies X402Payer;
}

/** Mock fetch: 402 (with accepts) until a PAYMENT-SIGNATURE header is present, then 200. */
function makeFetch(opts?: { body402?: unknown; always200?: boolean }): FetchLike & { mock: { calls: unknown[][] } } {
  return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const paid = new Headers(init?.headers).has("PAYMENT-SIGNATURE");
    if (paid || opts?.always200) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response(JSON.stringify(opts?.body402 ?? { x402Version: 2, accepts: [requirements] }), { status: 402 });
  }) as never;
}

describe("createX402Fetch", () => {
  it("passes a non-402 response through without paying", async () => {
    const payer = makePayer();
    const fetchMock = makeFetch({ always200: true });
    const res = await createX402Fetch(payer, { fetch: fetchMock })("https://api.example/x");
    expect(res.status).toBe(200);
    expect(payer.authorize).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it("on 402, authorizes and retries with the PAYMENT-SIGNATURE header, and not X-PAYMENT", async () => {
    const payer = makePayer();
    const fetchMock = makeFetch();
    const res = await createX402Fetch(payer, { fetch: fetchMock })("https://api.example/x");
    expect(res.status).toBe(200);
    expect(payer.authorize).toHaveBeenCalledWith(requirements);
    expect(fetchMock.mock.calls).toHaveLength(2);
    const retryInit = fetchMock.mock.calls[1][1] as RequestInit;
    // The header carries the payment alone: the requirements travel in it as `accepted`.
    const sent = new Headers(retryInit.headers);
    expect(sent.get("PAYMENT-SIGNATURE")).toBe(encodePaymentHeader(payload));
    // One copy only: the payment is about 10 KB, and a second would double it.
    expect(sent.has("X-PAYMENT")).toBe(false);
  });

  it("passes a 402 through when the payer can't satisfy it", async () => {
    const payer = makePayer(false);
    const fetchMock = makeFetch();
    const res = await createX402Fetch(payer, { fetch: fetchMock })("https://api.example/x");
    expect(res.status).toBe(402);
    expect(payer.authorize).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it("passes a 402 through when the body has no accepts[]", async () => {
    const payer = makePayer();
    const fetchMock = makeFetch({ body402: { error: "nope" } });
    const res = await createX402Fetch(payer, { fetch: fetchMock })("https://api.example/x");
    expect(res.status).toBe(402);
    expect(payer.authorize).not.toHaveBeenCalled();
  });

  it("uses a custom select to choose which payer pays which requirement", async () => {
    const alt = { ...requirements, scheme: "exact-evm" } as CantonPaymentRequirements;
    const payer = makePayer();
    const fetchMock = makeFetch({ body402: { x402Version: 2, accepts: [alt, requirements] } });
    const f = createX402Fetch(payer, {
      fetch: fetchMock,
      select: (accepts, payers) => {
        const match = accepts.find((r) => r.scheme === "exact");
        return match ? { payer: payers[0], requirements: match } : undefined;
      },
    });
    await f("https://api.example/x");
    expect(payer.authorize).toHaveBeenCalledWith(requirements);
  });

  it("routes each requirement to the first payer that supports it (multi-payer)", async () => {
    const evmPayer = {
      supports: (r) => r.scheme === "exact-evm",
      authorize: vi.fn(async () => payload),
    } satisfies X402Payer;
    const cantonPayer = {
      supports: (r) => r.scheme === "exact",
      authorize: vi.fn(async () => payload),
    } satisfies X402Payer;
    // Server offers canton-exact (`requirements`); only the Canton payer supports it.
    const fetchMock = makeFetch();
    await createX402Fetch([evmPayer, cantonPayer], { fetch: fetchMock })("https://api.example/x");
    expect(evmPayer.authorize).not.toHaveBeenCalled();
    expect(cantonPayer.authorize).toHaveBeenCalledWith(requirements);
  });
});
