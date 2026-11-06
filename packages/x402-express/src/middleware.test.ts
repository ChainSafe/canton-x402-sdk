import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer } from "node:http";
import express, { type Express } from "express";
import request from "supertest";
import {
  encodePaymentHeader,
  isCantonPaymentRequirements,
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
    amount: "500000000",
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

const ECHOED_EXTRA = {
  assetTransferMethod: "transfer-factory",
  executeBeforeSeconds: 120,
  instrumentId: { id: "Amulet", admin: "DSO::x" },
};

/** Build an `X-PAYMENT` header echoing acceptable requirements. */
function paymentHeader(overrides: Record<string, unknown> = {}): string {
  const requirements = {
    scheme: "exact",
    network: "canton:x",
    amount: "500000000",
    asset: "CC",
    extra: ECHOED_EXTRA,
    payTo: "merchant::x",
    resource: "https://f.example/paid",
    description: "Access",
    maxTimeoutSeconds: 60,
    ...overrides,
  } as unknown as CantonPaymentRequirements;
  const payload = {
    x402Version: 2,
    scheme: "exact",
    network: "canton:x",
    payload: {
      assetTransferMethod: "transfer-factory",
      payer: "alice::x",
      preparedTransaction: "b",
      preparedTxHash: "h",
      signature: "s",
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
          amount: (req) => (req.method === "GET" ? "900000000" : "100000000"),
        },
      }),
    );
    app.get("/paid", (_req, res) => res.json({ ok: true }));
    const res = await request(app).get("/paid");
    expect(res.status).toBe(402);
    expect(res.body.accepts[0].amount).toBe("900000000");
  });

  it("catches an underpayment above Number.MAX_SAFE_INTEGER", async () => {
    // Atomic units are 1e10 larger than the price, so a realistic CC amount can
    // exceed what a double represents. 2^53+1 and 2^53 are distinct atomic
    // amounts that collapse to the same double, so a Number compare reads the
    // underpayment as equal and lets it through. ~900,719.93 CC.
    const policy = "9007199254740993";
    const echoed = "9007199254740992";
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
          amount: policy,
          resource: "https://f.example/paid",
        },
      }),
    );
    app.get("/paid", (_req, res) => res.json({ ok: true }));
    const res = await request(app).get("/paid").set("X-PAYMENT", paymentHeader({ amount: echoed }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("policy_underpriced");
  });

  it("refuses an oversized echoed amount without parsing it", async () => {
    // The echoed amount reaches BigInt before any signature is checked, and
    // BigInt parsing is superlinear — ~300ms for three million digits against
    // ~6ms for Number. Node's default 16KB header limit hides this, but our own
    // docs tell merchants to raise maxHeaderSize for the Canton payload, so the
    // server here is built the way we tell them to build it. The length bound
    // in isValidAmount is what keeps this a cheap 402.
    stubFacilitator();
    const server = createServer({ maxHeaderSize: 4 * 1024 * 1024 }, makeApp());
    const started = Date.now();
    const res = await request(server)
      .get("/paid")
      .set("X-PAYMENT", paymentHeader({ amount: "9".repeat(1_000_000) }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("policy_amount_invalid");
    expect(Date.now() - started).toBeLessThan(2_000);
    server.close();
  });

  it("rejects a decimal amount from a BUILDER, not just the declarative spec", async () => {
    // The builder returned before the check, so a decimal reached the 402 and
    // the paid retry then threw on BigInt(policy.amount) — a 500 for the
    // merchant's own config, surfacing one request too late.
    stubFacilitator();
    const app = express();
    app.use(
      "/paid",
      paymentRequired({
        ...baseOptions,
        requirements: () =>
          ({
            scheme: "exact",
            network: "canton:x",
            amount: "0.05", // CC where atomic units are required
            asset: "CC",
            extra: { assetTransferMethod: "transfer-factory", executeBeforeSeconds: 120, instrumentId: { id: "Amulet", admin: "DSO::x" } },
            payTo: "merchant::x",
            resource: "https://f.example/paid",
            maxTimeoutSeconds: 60,
          }) as unknown as CantonPaymentRequirements,
      }),
    );
    app.get("/paid", (_req, res) => res.json({ ok: true }));
    const res = await request(app).get("/paid");
    expect(res.status).toBe(500);
    expect(res.body.details).toMatch(/atomic units/);
  });

  it("rejects a decimal amount in an additionalAccepts entry", async () => {
    // Advertised in the same 402, so it is held to the same rule.
    stubFacilitator();
    const app = express();
    app.use(
      "/paid",
      paymentRequired({
        ...baseOptions,
        additionalAccepts: () =>
          [{ ...JSON.parse(JSON.stringify(baseOptions.requirements)), amount: "0.10" }] as unknown as CantonPaymentRequirements[],
      }),
    );
    app.get("/paid", (_req, res) => res.json({ ok: true }));
    const res = await request(app).get("/paid");
    expect(res.status).toBe(500);
    expect(res.body.details).toMatch(/atomic units/);
  });

  it("rejects a decimal amount rather than quietly misreading it", async () => {
    // One unit everywhere: a merchant who writes "0.05" meaning 0.05 CC is
    // 1e10 out. The spec's unit is atomic, so the mistake is refused loudly
    // instead of quoting 5e-12 CC.
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
          amount: "0.05", // CC, where atomic units are expected
        },
      }),
    );
    app.get("/paid", (_req, res) => res.json({ ok: true }));
    const res = await request(app).get("/paid");
    expect(res.status).toBe(500);
  });

  it("advertises the reserved assetTransferMethod and a maxTimeoutSeconds", async () => {
    // Both are required of the 402 now, and a merchant states neither — the
    // method has one legal value and the timeout has a default.
    stubFacilitator();
    const app = express();
    app.use("/paid", paymentRequired(baseOptions));
    app.get("/paid", (_req, res) => res.json({ ok: true }));
    const res = await request(app).get("/paid");
    expect(res.status).toBe(402);
    expect(res.body.accepts[0].extra.assetTransferMethod).toBe("transfer-factory");
    expect(res.body.accepts[0].maxTimeoutSeconds).toBe(60);
  });

  it("takes maxTimeoutSeconds from the merchant, per request if it wants", async () => {
    stubFacilitator();
    const app = express();
    app.use(
      "/paid",
      paymentRequired({
        ...baseOptions,
        requirements: {
          network: "canton:x",
          payTo: "merchant::1220y",
          asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } },
          amount: "500000000",
          maxTimeoutSeconds: (req) => (req.path === "/slow" ? 600 : 30),
        },
      }),
    );
    app.get("/slow", (_req, res) => res.json({ ok: true }));
    app.get("/fast", (_req, res) => res.json({ ok: true }));
    expect((await request(app).get("/paid/slow")).body.accepts[0].maxTimeoutSeconds).toBe(600);
    expect((await request(app).get("/paid/fast")).body.accepts[0].maxTimeoutSeconds).toBe(30);
  });

  it("quotes an executeBeforeSeconds, and a memo only when the merchant sets one", async () => {
    stubFacilitator();
    const app = express();
    app.use("/paid", paymentRequired(baseOptions));
    app.get("/paid", (_req, res) => res.json({ ok: true }));
    const res = await request(app).get("/paid");
    expect(res.body.accepts[0].extra.executeBeforeSeconds).toBe(120);
    // Quoting a memo BINDS it (Rule 12), so one is never invented on the
    // merchant's behalf — an unasked-for memo would refuse honest payments.
    expect(res.body.accepts[0].extra).not.toHaveProperty("memo");
  });

  // Rule 12 compares the transfer against the requirements the PAYER echoed, so
  // on its own it proves only that the payer agreed with itself: it can drop
  // the memo and sign none, or echo any value and sign that. The middleware
  // keeps no record of what it issued, so a merchant reconciling by memo says so.
  describe("a quoted memo is only as good as the merchant's own check", () => {
    const quoting = (over: Partial<PaymentRequiredOptions> = {}) =>
      makeApp({
        requirements: { ...(baseOptions.requirements as object), memo: () => "order-1" } as never,
        ...over,
      });

    it.each([
      ["dropped from the echo", {}],
      ["one this merchant never issued", { memo: "someone-elses-order" }],
    ])("is accepted on its own when %s", async (_, extra) => {
      stubFacilitator();
      await request(quoting())
        .get("/paid")
        .set("X-PAYMENT", paymentHeader({ extra: { ...ECHOED_EXTRA, ...extra } }))
        .expect(200);
    });

    it("and refused when checkPayment says so", async () => {
      stubFacilitator();
      const app = quoting({
        checkPayment: ({ requirements }) =>
          requirements.extra.memo === "order-1" ? undefined : "policy_memo_unknown",
      });
      for (const extra of [{}, { memo: "someone-elses-order" }]) {
        const res = await request(app)
          .get("/paid")
          .set("X-PAYMENT", paymentHeader({ extra: { ...ECHOED_EXTRA, ...extra } }));
        expect(res.status).toBe(402);
        expect(res.body.error).toBe("policy_memo_unknown");
      }
    });
  });

  describe("checkPayment", () => {
    it("sees the payload and the echoed requirements, and refuses before settle", async () => {
      // Before settle is the point: a refusal after it would have moved funds.
      const fetchMock = stubFacilitator();
      let seen: { payer?: string } = {};
      const app = makeApp({
        settle: true,
        checkPayment: ({ payload }) => {
          seen = { payer: payload.payload.payer };
          return "policy_order_closed";
        },
      });
      const res = await request(app).get("/paid").set("X-PAYMENT", paymentHeader());
      expect(res.status).toBe(402);
      expect(res.body.error).toBe("policy_order_closed");
      expect(seen.payer).toBe("alice::x");
      for (const [url] of fetchMock.mock.calls) expect(String(url)).not.toContain("/v2/settle");
    });

    it("lets the payment through when it returns nothing", async () => {
      stubFacilitator();
      await request(makeApp({ checkPayment: () => undefined }))
        .get("/paid")
        .set("X-PAYMENT", paymentHeader())
        .expect(200);
    });
  });

  it("asks the merchant for a memo per challenge, and records what it issued", async () => {
    // Quoting a memo binds it (Rule 12), so it is the merchant's reconciliation
    // key: generated AND recorded merchant-side, one call per challenge.
    stubFacilitator();
    const seen: string[] = [];
    const app = express();
    app.use(
      "/paid",
      paymentRequired({
        ...baseOptions,
        requirements: {
          network: "canton:x",
          payTo: "merchant::1220y",
          asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } },
          amount: "500000000",
          executeBeforeSeconds: 300,
          memo: (req) => {
            const m = `invoice-${seen.length}${req.path}`;
            seen.push(m);
            return m;
          },
        },
      }),
    );
    app.get("/a", (_req, res) => res.json({ ok: true }));
    const first = await request(app).get("/paid/a");
    const second = await request(app).get("/paid/a");
    expect(first.body.accepts[0].extra.executeBeforeSeconds).toBe(300);
    expect(first.body.accepts[0].extra.memo).toBe("invoice-0/a");
    expect(second.body.accepts[0].extra.memo).toBe("invoice-1/a");
    expect(seen).toEqual(["invoice-0/a", "invoice-1/a"]); // merchant observed both
  });

  it("supports a full requirements builder function", async () => {
    stubFacilitator();
    const app = express();
    app.use(
      "/paid",
      paymentRequired({
        ...baseOptions,
        requirements: () => ({
          scheme: "exact",
          network: "canton:x",
          amount: "500000000",
          asset: "CC",
          extra: { assetTransferMethod: "transfer-factory", executeBeforeSeconds: 120, instrumentId: { id: "Amulet", admin: "DSO::x" } },
          payTo: "merchant::x",
          resource: "/r",
          description: "d",
          maxTimeoutSeconds: 60,
        }),
      }),
    );
    app.get("/paid", (_req, res) => res.json({ ok: true }));
    const res = await request(app).get("/paid");
    expect(res.status).toBe(402);
    // The builder owns the whole object: nothing is defaulted over it.
    expect(res.body.accepts[0]).toMatchObject({ resource: "/r", description: "d" });
  });

  it("responds 402 with well-formed requirements when there is no X-PAYMENT", async () => {
    stubFacilitator();
    const res = await request(makeApp()).get("/paid");
    expect(res.status).toBe(402);
    expect(res.body.x402Version).toBe(2);
    expect(res.body.error).toBe("payment_required");
    const req0 = res.body.accepts[0];
    expect(req0).toMatchObject({ payTo: "merchant::x", amount: "500000000", network: "canton:x" });
    // Not a field list: the guard is what a payer runs, so a required field the
    // middleware forgets to fill in fails here rather than at someone's client.
    expect(isCantonPaymentRequirements(req0)).toBe(true);
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

  it("forwards the facilitator's extensions.detail on a verify rejection", async () => {
    stubFacilitator({
      verify: {
        isValid: false,
        invalidReason: "internal_error",
        extensions: { detail: "authorization_amount_too_low", minAmountMicroUsdc: 2_000_000 },
      },
    });
    const res = await request(makeApp()).get("/paid").set("X-PAYMENT", paymentHeader());
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.details).toBe("authorization_amount_too_low");
  });

  it("omits details when the verify extensions.detail is not a string", async () => {
    stubFacilitator({ verify: { isValid: false, invalidReason: "internal_error", extensions: { detail: { code: 1 } } } });
    const res = await request(makeApp()).get("/paid").set("X-PAYMENT", paymentHeader());
    expect(res.status).toBe(402);
    expect(res.body).not.toHaveProperty("details");
  });

  it("hands back a FRESH challenge (not the dead echoed one) on nonce_replayed", async () => {
    stubFacilitator({ verify: { isValid: false, invalidReason: "nonce_replayed" } });
    // The memo is what carries per-challenge identity now, so quoting one is
    // what makes "fresh" observably different from "echoed".
    let issued = 0;
    const app = makeApp({
      requirements: { ...(baseOptions.requirements as object), memo: () => `challenge-${++issued}` } as never,
    });
    const res = await request(app)
      .get("/paid")
      .set("X-PAYMENT", paymentHeader({ extra: { ...ECHOED_EXTRA, memo: "spent-memo" } }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("nonce_replayed");
    // The echoed reference is spent; accepts[] must advertise a new one so a
    // retrying agent isn't looped on the dead challenge.
    expect(res.body.accepts[0].extra.memo).toBe("challenge-1");
    expect(res.body.accepts[0].extra.memo).not.toBe("spent-memo");
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
      .set("X-PAYMENT", paymentHeader({ amount: "100000000" }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("policy_underpriced");
  });

  it("rejects a malformed echoed amount that would slip past the '<' check", async () => {
    // BigInt throws on "abc", "Infinity" and "1e3" — a 500 where a 402 belongs.
    // It also parses what it should not: "0x10" is 16, "0b11" is 3, " 5 " is 5
    // and "" is 0, so an amount the merchant never quoted would compare as a
    // number. The format check is what keeps all of it a 402.
    stubFacilitator();
    for (const bad of ["abc", "Infinity", "1e3", " 5 ", "0x10", "0b11", "0o17"]) {
      const res = await request(makeApp())
        .get("/paid")
        .set("X-PAYMENT", paymentHeader({ amount: bad }));
      expect(res.status).toBe(402);
      expect(res.body.error).toBe("policy_amount_invalid");
    }
  });

  it("rejects an EMPTY echoed amount at decode, before policy", async () => {
    // BigInt("") is 0, so this one matters — but the envelope's nonEmptyString
    // catches it first, which is why the code is bad_payload and not
    // policy_amount_invalid. Asserted so the earlier guard cannot quietly go.
    stubFacilitator();
    const res = await request(makeApp())
      .get("/paid")
      .set("X-PAYMENT", paymentHeader({ amount: "" }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("bad_payload");
  });

  it("rejects a look-alike instrument from another registry", async () => {
    // The symbol is not the instrument. `asset` says "CC" either way, so the
    // admin — the registry that issued it — is what has to be compared, or a
    // merchant is paid in a token that merely shares a name.
    stubFacilitator();
    const res = await request(makeApp())
      .get("/paid")
      .set(
        "X-PAYMENT",
        paymentHeader({ extra: { assetTransferMethod: "transfer-factory", executeBeforeSeconds: 120, instrumentId: { id: "Amulet", admin: "DSO::impostor" } } }),
      );
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("policy_asset");
  });

  it("rejects an echoed instrument id that is not the priced one", async () => {
    // Symbol and admin left alone, so only the id comparison can catch this.
    stubFacilitator();
    const res = await request(makeApp())
      .get("/paid")
      .set(
        "X-PAYMENT",
        paymentHeader({ extra: { assetTransferMethod: "transfer-factory", executeBeforeSeconds: 120, instrumentId: { id: "USDCx", admin: "DSO::x" } } }),
      );
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("policy_asset");
  });

  it("rejects an echoed symbol that is not the priced one", async () => {
    // The instrument is left alone, so only the symbol comparison catches it.
    // A merchant quoting CC must not be paid against a quote that says USDCx,
    // even where the instrument underneath is the one it priced.
    stubFacilitator();
    const res = await request(makeApp())
      .get("/paid")
      .set("X-PAYMENT", paymentHeader({ asset: "USDCx" }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("policy_asset");
  });

  it("answers 402, not 500, when the echoed requirements carry no `extra`", async () => {
    // The header is only ENVELOPE-validated on decode, and the envelope is a
    // looseObject that does not require `extra`. Reading `extra.instrumentId`
    // without narrowing threw a TypeError, so attacker-controlled input chose
    // our status code — and a 500 reads as a merchant bug, not a refusal.
    stubFacilitator();
    const res = await request(makeApp())
      .get("/paid")
      .set("X-PAYMENT", paymentHeader({ extra: undefined }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("policy_requirements_invalid");
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

  describe("onReject", () => {
    it("reports a verify rejection with its details and full extensions", async () => {
      const extensions = { detail: "authorization_amount_too_low", minAmountMicroUsdc: 2_000_000, amountMicroUsdc: 5_000 };
      stubFacilitator({ verify: { isValid: false, invalidReason: "internal_error", extensions } });
      const onReject = vi.fn();
      await request(makeApp({ onReject })).get("/paid").set("X-PAYMENT", paymentHeader());
      expect(onReject).toHaveBeenCalledOnce();
      expect(onReject.mock.calls[0][0]).toEqual({
        status: 402,
        reason: "internal_error",
        details: "authorization_amount_too_low",
        extensions,
      });
    });

    it("reports a settle rejection", async () => {
      stubFacilitator({ settle: { success: false, errorReason: "execution_failed", errorDetails: "boom" } });
      const onReject = vi.fn();
      const res = await request(makeApp({ settle: true, onReject })).get("/paid").set("X-PAYMENT", paymentHeader());
      expect(res.status).toBe(402);
      expect(onReject.mock.calls[0][0]).toMatchObject({ status: 402, reason: "execution_failed", details: "boom" });
    });

    it("reports a policy rejection", async () => {
      stubFacilitator();
      const onReject = vi.fn();
      await request(makeApp({ onReject }))
        .get("/paid")
        .set("X-PAYMENT", paymentHeader({ amount: "100000000" }));
      expect(onReject.mock.calls[0][0]).toMatchObject({ status: 402, reason: "policy_underpriced" });
    });

    it("reports a facilitator error with the underlying error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("down", { status: 503 })),
      );
      const onReject = vi.fn();
      const res = await request(makeApp({ onReject })).get("/paid").set("X-PAYMENT", paymentHeader());
      expect(res.status).toBe(502);
      expect(onReject.mock.calls[0][0]).toMatchObject({ status: 502, reason: "facilitator_error" });
      expect(onReject.mock.calls[0][0].error).toBeInstanceOf(Error);
    });

    it("is not called for the plain challenge or a paid request", async () => {
      stubFacilitator();
      const onReject = vi.fn();
      const app = makeApp({ onReject });
      expect((await request(app).get("/paid")).status).toBe(402);
      expect((await request(app).get("/paid").set("X-PAYMENT", paymentHeader())).status).toBe(200);
      expect(onReject).not.toHaveBeenCalled();
    });

    it("still sends the response when the hook throws", async () => {
      stubFacilitator({ verify: { isValid: false, invalidReason: "bad_signature" } });
      const onReject = vi.fn(() => {
        throw new Error("logger down");
      });
      const res = await request(makeApp({ onReject })).get("/paid").set("X-PAYMENT", paymentHeader());
      expect(res.status).toBe(402);
      expect(res.body.error).toBe("bad_signature");
    });

    it("swallows a rejected promise from an async hook", async () => {
      stubFacilitator({ verify: { isValid: false, invalidReason: "bad_signature" } });
      const onReject = vi.fn(async () => {
        throw new Error("remote logger down");
      });
      const res = await request(makeApp({ onReject })).get("/paid").set("X-PAYMENT", paymentHeader());
      expect(res.status).toBe(402);
      // Let the hook's promise settle; vitest fails the run on an unhandled rejection.
      await new Promise((r) => setImmediate(r));
      expect(onReject).toHaveBeenCalledOnce();
    });
  });
});
