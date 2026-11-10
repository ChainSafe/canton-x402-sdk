import { describe, it, expect, vi, afterEach } from "vitest";
import type { CantonPaymentPayload, CantonPaymentRequirements } from "@chainsafe/x402-core";
import { FacilitatorClient, FacilitatorError } from "./facilitator";

const requirements = { scheme: "exact", network: "canton:x", payTo: "merchant::x" } as unknown as CantonPaymentRequirements;
const payload = { x402Version: 2, accepted: requirements, payload: {} } as unknown as CantonPaymentPayload;

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
      paymentPayload: { accepted: { scheme: "exact", network: "canton:x" } },
      paymentRequirements: { payTo: "merchant::x" },
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

  it("verify sends the api key as a bearer header (async getter)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({ isValid: true, payer: "p" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new FacilitatorClient("https://f.example", { apiKey: async () => "tok-123" });
    await client.verify(payload, requirements);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://f.example/v2/verify");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer tok-123" });
  });

  it("verify omits Authorization when no api key is set", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({ isValid: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new FacilitatorClient("https://f.example"); // no opts
    await client.verify(payload, requirements);
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).not.toHaveProperty("Authorization");
  });

  it("supported never sends an Authorization header, even with an api key", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({ kinds: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new FacilitatorClient("https://f.example", { apiKey: "tok-123" });
    await client.supported();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://f.example/v2/supported");
    expect(init?.headers).not.toHaveProperty("Authorization");
  });
});

describe("FacilitatorClient /v2/supported cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const kinds = (network: string) => ({ kinds: [{ x402Version: 2, scheme: "exact", network }] });

  it("serves a second call from cache instead of fetching again", async () => {
    const fetchMock = vi.fn(async () => json(kinds("canton:one")));
    vi.stubGlobal("fetch", fetchMock);
    const client = new FacilitatorClient("https://f.example");

    const first = await client.supported();
    const second = await client.supported();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("fetches again once the TTL has passed", async () => {
    vi.useFakeTimers();
    let n = 0;
    const fetchMock = vi.fn(async () => json(kinds(`canton:${++n}`)));
    vi.stubGlobal("fetch", fetchMock);
    const client = new FacilitatorClient("https://f.example", { supportedTtlMs: 1_000 });

    expect((await client.supported()).kinds[0].network).toBe("canton:1");
    vi.advanceTimersByTime(999);
    expect((await client.supported()).kinds[0].network).toBe("canton:1");
    vi.advanceTimersByTime(2);
    expect((await client.supported()).kinds[0].network).toBe("canton:2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetches every time when the TTL is zero", async () => {
    const fetchMock = vi.fn(async () => json(kinds("canton:one")));
    vi.stubGlobal("fetch", fetchMock);
    const client = new FacilitatorClient("https://f.example", { supportedTtlMs: 0 });

    await client.supported();
    await client.supported();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refresh: true bypasses a cache entry that is still fresh", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => json(kinds(`canton:${++n}`)));
    vi.stubGlobal("fetch", fetchMock);
    const client = new FacilitatorClient("https://f.example");

    expect((await client.supported()).kinds[0].network).toBe("canton:1");
    expect((await client.supported({ refresh: true })).kinds[0].network).toBe("canton:2");
    // ...and the refreshed value replaces what the cache serves next.
    expect((await client.supported()).kinds[0].network).toBe("canton:2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent cold-start callers onto one request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = vi.fn(async () => {
      await gate;
      return json(kinds("canton:one"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new FacilitatorClient("https://f.example");

    const all = Promise.all([client.supported(), client.supported(), client.supported()]);
    release();
    const results = await all;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const res of results) expect(res.kinds[0].network).toBe("canton:one");
  });

  it("serves the stale value when a refresh fails", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) return json(kinds("canton:one"));
      return json({ error: "down" }, 503);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new FacilitatorClient("https://f.example", { supportedTtlMs: 1_000 });

    await client.supported();
    vi.advanceTimersByTime(2_000);

    // A facilitator blip must not stop a merchant quoting.
    expect((await client.supported()).kinds[0].network).toBe("canton:one");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to stale for a caller that joined a failing request, not just the one that started it", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) return json(kinds("canton:one"));
      await gate;
      return json({ error: "down" }, 503);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new FacilitatorClient("https://f.example", { supportedTtlMs: 1_000 });

    await client.supported();
    vi.advanceTimersByTime(2_000);

    const joined = Promise.all([client.supported(), client.supported()]);
    release();
    const results = await joined;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const res of results) expect(res.kinds[0].network).toBe("canton:one");
  });

  it("throws when the first fetch fails and there is nothing stale to serve", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "down" }, 503)));
    const client = new FacilitatorClient("https://f.example");

    const err: FacilitatorError = await client.supported().catch((e) => e);
    expect(err).toBeInstanceOf(FacilitatorError);
    expect(err.status).toBe(503);
    expect(err.endpoint).toBe("/v2/supported");
  });

  it("retries after a failure rather than caching it", async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt += 1;
      return attempt === 1 ? json({ error: "down" }, 503) : json(kinds("canton:one"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new FacilitatorClient("https://f.example");

    await client.supported().catch(() => undefined);
    expect((await client.supported()).kinds[0].network).toBe("canton:one");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an older fetch landing last does not overwrite a newer answer", async () => {
    // A refresh starting while another request runs leaves two in flight. If
    // the older lands last, the cache would serve its answer for a full TTL —
    // undoing the refresh that was called to correct it.
    const gates: Array<() => void> = [];
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      const mine = ++call;
      await new Promise<void>((r) => gates.push(r));
      return json(kinds(mine === 1 ? "canton:old" : "canton:new"));
    }));
    const client = new FacilitatorClient("https://f.example");

    const older = client.supported();
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    const newer = client.supported({ refresh: true });
    await vi.waitFor(() => expect(gates).toHaveLength(2));

    gates[1]();
    expect((await newer).kinds[0].network).toBe("canton:new");
    gates[0]();
    // The older caller still gets what it fetched.
    expect((await older).kinds[0].network).toBe("canton:old");

    expect((await client.supported()).kinds[0].network).toBe("canton:new");
  });

  it("a failed refresh throws rather than quietly serving the stale value", async () => {
    // `refresh` means "I need current data". Answering with the old value is
    // the opposite of what was asked, and the caller cannot tell from the
    // result — so this is the one path where stale does NOT beat nothing.
    let attempt = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempt += 1;
      return attempt === 1 ? json(kinds("canton:one")) : json({ error: "down" }, 503);
    }));
    const client = new FacilitatorClient("https://f.example");

    await client.supported();
    const err: FacilitatorError = await client.supported({ refresh: true }).catch((e) => e);
    expect(err).toBeInstanceOf(FacilitatorError);
    expect(err.status).toBe(503);

    // And the cache is untouched: the TTL path still serves what it had.
    expect((await client.supported()).kinds[0].network).toBe("canton:one");
  });

  it("gives each caller its own copy, so an edit cannot poison the cache", async () => {
    // Before the cache every call parsed a fresh body. Sharing the cached
    // object would make one caller's narrowing the next caller's truth.
    const fetchMock = vi.fn(async () => json(kinds("canton:one")));
    vi.stubGlobal("fetch", fetchMock);
    const client = new FacilitatorClient("https://f.example");

    const first = await client.supported();
    first.kinds = first.kinds.filter((k) => k.network === "canton:nope");
    expect(first.kinds).toHaveLength(0);

    const second = await client.supported();
    expect(second.kinds).toHaveLength(1);
    expect(second.kinds[0].network).toBe("canton:one");
    expect(second).not.toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives a copy on the stale-fallback path too", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempt += 1;
      return attempt === 1 ? json(kinds("canton:one")) : json({ error: "down" }, 503);
    }));
    const client = new FacilitatorClient("https://f.example", { supportedTtlMs: 1_000 });

    await client.supported();
    vi.advanceTimersByTime(2_000);
    const stale = await client.supported();
    stale.kinds.length = 0;

    vi.advanceTimersByTime(2_000);
    expect((await client.supported()).kinds).toHaveLength(1);
  });

  it("caches per client, so one deployment's answer never serves another", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      json(kinds(url.startsWith("https://a.") ? "canton:a" : "canton:b")),
    );
    vi.stubGlobal("fetch", fetchMock);

    const a = new FacilitatorClient("https://a.example");
    const b = new FacilitatorClient("https://b.example");

    expect((await a.supported()).kinds[0].network).toBe("canton:a");
    expect((await b.supported()).kinds[0].network).toBe("canton:b");
  });
});
