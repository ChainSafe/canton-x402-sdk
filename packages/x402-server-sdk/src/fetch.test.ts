import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, describe, it, expect, vi } from "vitest";
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
  amount: "0.05",
  asset: "CC",
  extra: { instrumentId: { id: "Amulet", admin: "DSO::x" } },
  payTo: "merchant::x",
  resource: "https://api.example/paid",
  nonce: "n1",
  validBefore: "2999-01-01T00:00:00.000Z",
} as CantonPaymentRequirements;

const payload = {
  x402Version: 2,
  scheme: "exact",
  network: "canton:x",
  payload: {
    payer: "alice::x",
    preparedTransaction: "cHJlcA==",
    preparedTransactionHash: "deadbeef",
    partySignature: "cafe",
    requirementsHash: "rh",
    publicKey: "cGs=",
    hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
  },
} as unknown as CantonPaymentPayload;

function makePayer(supports = true) {
  return { supports: () => supports, authorize: vi.fn(async () => payload) } satisfies X402Payer;
}

/** Mock fetch: 402 (with accepts) until an X-PAYMENT header is present, then 200. */
function makeFetch(opts?: {
  body402?: unknown;
  always200?: boolean;
}): FetchLike & { mock: { calls: unknown[][] } } {
  return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const paid = new Headers(init?.headers).has("X-PAYMENT");
    if (paid || opts?.always200) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response(
      JSON.stringify(opts?.body402 ?? { x402Version: 2, accepts: [requirements] }),
      { status: 402 },
    );
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

  it("on 402, authorizes and retries with the X-PAYMENT header", async () => {
    const payer = makePayer();
    const fetchMock = makeFetch();
    const res = await createX402Fetch(payer, { fetch: fetchMock })("https://api.example/x");
    expect(res.status).toBe(200);
    expect(payer.authorize).toHaveBeenCalledWith(requirements);
    expect(fetchMock.mock.calls).toHaveLength(2);
    const retryInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(new Headers(retryInit.headers).get("X-PAYMENT")).toBe(
      encodePaymentHeader(payload, requirements),
    );
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
    const alt = { ...requirements, scheme: "exact-evm", nonce: "n2" } as CantonPaymentRequirements;
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

interface ReceivedRequest {
  method: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

/** Real HTTP transport; only payer authorization uses the fixture above. */
async function createMerchant(
  options: {
    expected?: Record<string, string>;
    alwaysStatus?: number;
  } = {},
) {
  const received: ReceivedRequest[] = [];
  const expected = options.expected ?? { authorization: "Bearer app", "x-tenant": "tenant" };
  const payment = encodePaymentHeader(payload, requirements);
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
      else if (Buffer.isBuffer(chunk)) chunks.push(chunk);
      else throw new Error("Unexpected HTTP body chunk");
    }
    received.push({
      method: request.method,
      headers: { ...request.headers },
      body: Buffer.concat(chunks).toString(),
    });
    const paid = request.headers["x-payment"] === payment;
    const headersMatch = Object.entries(expected).every(
      ([name, value]) => request.headers[name] === value,
    );
    const status = options.alwaysStatus ?? (paid ? (headersMatch ? 200 : 401) : 402);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ x402Version: 2, accepts: [requirements] }));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  return { url: `http://127.0.0.1:${address.port}/paid`, received };
}

describe("createX402Fetch with native fetch", () => {
  const requestHeaders = { authorization: "Bearer app", "x-tenant": "tenant" };

  describe.each(["GET", "POST"])("bodyless %s Request", (method) => {
    it.each([
      { name: "omitted init", init: undefined },
      { name: "empty init", init: {} },
      { name: "undefined headers", init: { headers: undefined } },
    ])("preserves inherited headers with $name", async ({ init }) => {
      const merchant = await createMerchant();
      const payer = makePayer();
      const request = new Request(merchant.url, { method, headers: requestHeaders });
      const response = await createX402Fetch(payer)(request, init);

      expect(response.status).toBe(200);
      expect(merchant.received).toHaveLength(2);
      for (const received of merchant.received) {
        expect(received.method).toBe(method);
        expect(received.headers).toMatchObject(requestHeaders);
        expect(received.body).toBe("");
      }
      expect(merchant.received[1].headers["x-payment"]).toBe(
        encodePaymentHeader(payload, requirements),
      );
      expect(request.headers.has("x-payment")).toBe(false);
      expect(request.bodyUsed).toBe(false);
    });
  });

  const replacements: { name: string; headers: NonNullable<RequestInit["headers"]> }[] = [
    { name: "record", headers: { "x-replacement": "init" } },
    { name: "Headers", headers: new Headers({ "x-replacement": "init" }) },
    { name: "tuples", headers: [["x-replacement", "init"]] },
  ];
  it.each(replacements)("preserves explicit $name header replacement", async ({ headers }) => {
    const merchant = await createMerchant({ expected: { "x-replacement": "init" } });
    const response = await createX402Fetch(makePayer())(
      new Request(merchant.url, { headers: requestHeaders }),
      { headers },
    );

    expect(response.status).toBe(200);
    expect(merchant.received).toHaveLength(2);
    for (const received of merchant.received) {
      expect(received.headers["x-replacement"]).toBe("init");
      expect(received.headers.authorization).toBeUndefined();
      expect(received.headers["x-tenant"]).toBeUndefined();
    }
  });

  it("keeps an explicitly empty headers replacement empty", async () => {
    const merchant = await createMerchant({ expected: {} });
    const response = await createX402Fetch(makePayer())(
      new Request(merchant.url, { headers: requestHeaders }),
      { headers: {} },
    );

    expect(response.status).toBe(200);
    expect(merchant.received).toHaveLength(2);
    for (const received of merchant.received) {
      expect(received.headers.authorization).toBeUndefined();
      expect(received.headers["x-tenant"]).toBeUndefined();
    }
  });

  it("preserves URL plus init headers and replayable POST bodies", async () => {
    const merchant = await createMerchant();
    const response = await createX402Fetch(makePayer())(merchant.url, {
      method: "POST",
      headers: requestHeaders,
      body: "operation=read",
    });

    expect(response.status).toBe(200);
    expect(merchant.received).toHaveLength(2);
    for (const received of merchant.received) {
      expect(received.headers).toMatchObject(requestHeaders);
      expect(received.body).toBe("operation=read");
    }
  });

  it("passes a non-402 Request response through without authorization", async () => {
    const merchant = await createMerchant({ alwaysStatus: 200 });
    const payer = makePayer();
    const response = await createX402Fetch(payer)(
      new Request(merchant.url, { headers: requestHeaders }),
    );

    expect(response.status).toBe(200);
    expect(merchant.received).toHaveLength(1);
    expect(merchant.received[0].headers).toMatchObject(requestHeaders);
    expect(payer.authorize).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toHaveProperty("x402Version", 2);
  });

  it("does not retry when no payer supports the requirement", async () => {
    const merchant = await createMerchant();
    const payer = makePayer(false);
    const response = await createX402Fetch(payer)(
      new Request(merchant.url, { headers: requestHeaders }),
    );

    expect(response.status).toBe(402);
    expect(merchant.received).toHaveLength(1);
    expect(payer.authorize).not.toHaveBeenCalled();
  });

  it("returns a second 402 without another authorization", async () => {
    const merchant = await createMerchant({ alwaysStatus: 402 });
    const payer = makePayer();
    const response = await createX402Fetch(payer)(
      new Request(merchant.url, { headers: requestHeaders }),
    );

    expect(response.status).toBe(402);
    expect(merchant.received).toHaveLength(2);
    expect(payer.authorize).toHaveBeenCalledTimes(1);
  });

  it("retains the documented limitation for consumed Request bodies", async () => {
    const merchant = await createMerchant();
    const request = new Request(merchant.url, {
      method: "POST",
      headers: requestHeaders,
      body: "one-shot",
    });

    await expect(createX402Fetch(makePayer())(request)).rejects.toBeInstanceOf(TypeError);
    expect(merchant.received).toHaveLength(1);
    expect(merchant.received[0].body).toBe("one-shot");
  });

  it("replaces a stale payment header without mutating the input Request", async () => {
    const merchant = await createMerchant();
    const request = new Request(merchant.url, {
      headers: { ...requestHeaders, "x-payment": "stale" },
    });
    const response = await createX402Fetch(makePayer())(request);

    expect(response.status).toBe(200);
    expect(merchant.received).toHaveLength(2);
    expect(merchant.received[0].headers["x-payment"]).toBe("stale");
    expect(merchant.received[1].headers["x-payment"]).toBe(
      encodePaymentHeader(payload, requirements),
    );
    expect(request.headers.get("x-payment")).toBe("stale");
  });
});
