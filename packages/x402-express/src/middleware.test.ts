import { describe, it, expect, vi, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import {
  encodePaymentHeader,
  type CantonPaymentPayload,
  type CantonPaymentRequirements,
} from "@chainsafe/x402-core";
import { FacilitatorClient } from "@chainsafe/x402-client";
import { paymentRequired, type PaymentRequiredOptions } from "./middleware";

const baseOptions: PaymentRequiredOptions = {
  facilitator: new FacilitatorClient("https://f.example", { apiKey: "k" }),
  requirements: {
    network: "canton:x",
    payTo: "merchant::x",
    asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } },
    amount: "0.05",
    // Fixed resource so the rebuilt policy matches the echoed header deterministically
    // (default is absoluteUrl(req), whose host/port vary per test run).
    resource: "https://f.example/paid",
  },
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A verify/settle-happy facilitator. */
function stubFacilitator(over?: { verify?: unknown; settle?: unknown }) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/v2/verify")) return json(over?.verify ?? { isValid: true, payer: "alice::x" });
    if (url.includes("/v2/settle"))
      return json(over?.settle ?? { success: true, network: "canton:x", transaction: "upd-1", payer: "alice::x" });
    return new Response("no route", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function makeApp(opts: Partial<PaymentRequiredOptions> = {}): Express {
  const app = express();
  app.use("/paid", paymentRequired({ ...baseOptions, ...opts }));
  app.get("/paid", (req, res) => {
    res.json({ ok: true, payer: req.x402?.payer, settled: Boolean(req.x402?.settle) });
  });
  return app;
}

/** Build an `X-PAYMENT` header echoing acceptable requirements. */
function paymentHeader(overrides: Record<string, unknown> = {}): string {
  const requirements = {
    scheme: "exact-canton",
    network: "canton:x",
    maxAmountRequired: "0.05",
    asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } },
    payTo: "merchant::x",
    resource: "https://f.example/paid",
    description: "Access",
    nonce: "nonce-1",
    validBefore: new Date(Date.now() + 300_000).toISOString(),
    ...overrides,
  } as unknown as CantonPaymentRequirements;
  const payload = {
    x402Version: 2,
    scheme: "exact-canton",
    network: "canton:x",
    payload: {
      payer: "alice::x",
      preparedTransaction: "b",
      preparedTransactionHash: "h",
      partySignature: "s",
      requirementsHash: "rh",
      publicKey: "pk",
      hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
    },
  } as CantonPaymentPayload;
  return encodePaymentHeader(payload, requirements);
}

describe("paymentRequired", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves per-request field functions in the requirements spec", async () => {
    stubFacilitator();
    const app = express();
    app.use(
      "/paid",
      paymentRequired({
        ...baseOptions,
        requirements: {
          network: "canton:x",
          payTo: "merchant::x",
          asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } },
          amount: (req) => (req.method === "GET" ? "0.09" : "0.01"),
        },
      }),
    );
    app.get("/paid", (_req, res) => res.json({ ok: true }));
    const res = await request(app).get("/paid");
    expect(res.status).toBe(402);
    expect(res.body.accepts[0].maxAmountRequired).toBe("0.09");
  });

  it("uses a merchant-supplied nonce generator (so it can record it)", async () => {
    stubFacilitator();
    const seen: string[] = [];
    const app = express();
    app.use(
      "/paid",
      paymentRequired({
        ...baseOptions,
        requirements: {
          network: "canton:x",
          payTo: "merchant::x",
          asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } },
          amount: "0.05",
          nonce: () => {
            const n = `merchant-nonce-${seen.length}`;
            seen.push(n);
            return n;
          },
        },
      }),
    );
    app.get("/paid", (_req, res) => res.json({ ok: true }));
    const res = await request(app).get("/paid");
    expect(res.body.accepts[0].nonce).toBe("merchant-nonce-0");
    expect(seen).toEqual(["merchant-nonce-0"]); // merchant observed/recorded it
  });

  it("supports a full requirements builder function", async () => {
    stubFacilitator();
    const app = express();
    app.use(
      "/paid",
      paymentRequired({
        ...baseOptions,
        requirements: () => ({
          scheme: "exact-canton",
          network: "canton:x",
          maxAmountRequired: "0.05",
          asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } },
          payTo: "merchant::x",
          resource: "/r",
          description: "d",
          nonce: "custom-nonce",
          validBefore: new Date(Date.now() + 300_000).toISOString(),
        }),
      }),
    );
    app.get("/paid", (_req, res) => res.json({ ok: true }));
    const res = await request(app).get("/paid");
    expect(res.status).toBe(402);
    expect(res.body.accepts[0].nonce).toBe("custom-nonce");
  });

  it("responds 402 with well-formed requirements when there is no X-PAYMENT", async () => {
    stubFacilitator();
    const res = await request(makeApp()).get("/paid");
    expect(res.status).toBe(402);
    expect(res.body.x402Version).toBe(2);
    expect(res.body.error).toBe("payment_required");
    const req0 = res.body.accepts[0];
    expect(req0).toMatchObject({ payTo: "merchant::x", maxAmountRequired: "0.05", network: "canton:x" });
    expect(typeof req0.nonce).toBe("string");
    expect(Date.parse(req0.validBefore)).toBeGreaterThan(Date.now());
  });

  it("verifies and lets a paid request through (verify-only by default, no settle)", async () => {
    const fetchMock = stubFacilitator();
    const res = await request(makeApp()).get("/paid").set("X-PAYMENT", paymentHeader());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, payer: "alice::x", settled: false });
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("/v2/verify"))).toBe(true);
    expect(calls.some((u) => u.includes("/v2/settle"))).toBe(false);
  });

  it("responds 402 with the reason when verify is invalid", async () => {
    stubFacilitator({ verify: { isValid: false, invalidReason: "bad_signature" } });
    const res = await request(makeApp()).get("/paid").set("X-PAYMENT", paymentHeader());
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("bad_signature");
  });

  it("hands back a FRESH challenge (not the dead echoed one) on nonce_replayed", async () => {
    stubFacilitator({ verify: { isValid: false, invalidReason: "nonce_replayed" } });
    const res = await request(makeApp())
      .get("/paid")
      .set("X-PAYMENT", paymentHeader({ nonce: "dead-nonce" }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("nonce_replayed");
    // The echoed nonce is spent; accepts[] must advertise a new one so a retrying
    // agent isn't looped on the dead challenge.
    expect(res.body.accepts[0].nonce).not.toBe("dead-nonce");
  });

  it("settles when settle mode is enabled and sets X-PAYMENT-RESPONSE", async () => {
    const fetchMock = stubFacilitator();
    const res = await request(makeApp({ settle: true })).get("/paid").set("X-PAYMENT", paymentHeader());
    expect(res.status).toBe(200);
    expect(res.body.settled).toBe(true);
    expect(res.headers["x-payment-response"]).toBe("upd-1");
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.includes("/v2/settle"))).toBe(true);
  });

  it("responds 402 bad_payload on an undecodable X-PAYMENT", async () => {
    stubFacilitator();
    const res = await request(makeApp()).get("/paid").set("X-PAYMENT", "!!!not-base64-json!!!");
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("bad_payload");
  });

  it("rejects an echoed requirement that undercuts the merchant price", async () => {
    stubFacilitator();
    const res = await request(makeApp())
      .get("/paid")
      .set("X-PAYMENT", paymentHeader({ maxAmountRequired: "0.01" }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("policy_underpriced");
  });

  it("rejects a malformed echoed amount that would slip past the '<' check", async () => {
    // Number("abc") is NaN and Number("Infinity") is Infinity — both make the
    // underpricing comparison false, so the format must be validated first.
    stubFacilitator();
    for (const bad of ["abc", "Infinity", "1e3", " 5 "]) {
      const res = await request(makeApp())
        .get("/paid")
        .set("X-PAYMENT", paymentHeader({ maxAmountRequired: bad }));
      expect(res.status).toBe(402);
      expect(res.body.error).toBe("policy_amount_invalid");
    }
  });

  it("rejects a payment minted for a different resource (request↔payment binding)", async () => {
    // Same price/payTo/asset, but the payment was issued for another path — it
    // must not be replayable against this one.
    stubFacilitator();
    const res = await request(makeApp())
      .get("/paid")
      .set("X-PAYMENT", paymentHeader({ resource: "https://f.example/other" }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("policy_resource");
  });
});
