import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer } from "node:http";
import express, { type Express } from "express";
import request from "supertest";
import {
  decodePayloadTransfer,
  encodePaymentHeader,
  isCantonPaymentRequirements,
  isCantonPaymentRequiredResponse,
  type CantonPaymentPayload,
  type CantonPaymentRequirements,
} from "@chainsafe/x402-core";
import { FacilitatorClient } from "@chainsafe/x402-client";
import { paymentRequired } from "./middleware";
import { TermsError } from "./options";
import type { PaymentRejectionInfo, PaymentRequiredOptions, RequirementsSpec } from "./options";

// The real decoder, spied on so a test can stand in a decodable transfer without
// building a prepared transaction: the fixture's `preparedTransaction` is not one.
vi.mock("@chainsafe/x402-core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@chainsafe/x402-core")>();
  return { ...core, decodePayloadTransfer: vi.fn(core.decodePayloadTransfer) };
});

const baseOptions: PaymentRequiredOptions = {
  facilitator: new FacilitatorClient("https://f.example", { apiKey: "k" }),
  requirements: {
    network: "canton:x",
    payTo: "merchant::x",
    // Fixed resource so the rebuilt policy matches the echoed header deterministically
    // (default is absoluteUrl(req), whose host/port vary per test run).
    resource: "https://f.example/paid",
    accepts: [
      {
        asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } },
        amount: "500000000",
      },
    ],
  },
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A verify/settle-happy facilitator. */
function stubFacilitator(over?: { verify?: unknown; settle?: unknown }) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/v2/verify"))
      return json(over?.verify ?? { isValid: true, payer: "alice::x" });
    if (url.includes("/v2/settle"))
      return json(
        over?.settle ?? {
          success: true,
          network: "canton:x",
          transaction: "upd-1",
          payer: "alice::x",
        },
      );
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

/** Build a `PAYMENT-SIGNATURE` header whose payment chose (`accepted`) acceptable requirements. */
function paymentHeader(
  overrides: Record<string, unknown> = {},
  inner: Record<string, unknown> = {},
  envelope: Record<string, unknown> = {},
): string {
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
    accepted: requirements,
    payload: {
      assetTransferMethod: "transfer-factory",
      preparedTransaction: "b",
      preparedTxHash: "h",
      signature: "s",
      publicKey: "pk",
      hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
      ...inner,
    },
    ...envelope,
  } as unknown as CantonPaymentPayload;
  return encodePaymentHeader(payload);
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
          accepts: [
            {
              asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } },
              amount: (req) => (req.method === "GET" ? "900000000" : "100000000"),
            },
          ],
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
          resource: "https://f.example/paid",
          accepts: [
            {
              asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } },
              amount: policy,
            },
          ],
        },
      }),
    );
    app.get("/paid", (_req, res) => res.json({ ok: true }));
    const res = await request(app)
      .get("/paid")
      .set("PAYMENT-SIGNATURE", paymentHeader({ amount: echoed }));
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
      .set("PAYMENT-SIGNATURE", paymentHeader({ amount: "9".repeat(1_000_000) }));
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
          [{
            scheme: "exact",
            network: "canton:x",
            amount: "0.05", // CC where atomic units are required
            asset: "CC",
            extra: {
              assetTransferMethod: "transfer-factory",
              executeBeforeSeconds: 120,
              instrumentId: { id: "Amulet", admin: "DSO::x" },
            },
            payTo: "merchant::x",
            resource: "https://f.example/paid",
            maxTimeoutSeconds: 60,
          }] as unknown as CantonPaymentRequirements[],
      }),
    );
    app.get("/paid", (_req, res) => res.json({ ok: true }));
    const res = await request(app).get("/paid");
    expect(res.status).toBe(500);
    expect(res.body.details).toMatch(/atomic units/);
  });

  it("rejects a decimal amount in any way to pay, not just the first", async () => {
    // Every entry is advertised in the same 402, so each is held to the rule.
    stubFacilitator();
    const app = express();
    app.use(
      "/paid",
      paymentRequired({
        ...baseOptions,
        requirements: {
          network: "canton:x",
          payTo: "merchant::x",
          resource: "https://f.example/paid",
          accepts: [
            { asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } }, amount: "500000000" },
            // The second way to pay carries the decimal.
            { asset: { instrumentId: { id: "USDCx", admin: "ISSUER::x" } }, amount: "0.10" },
          ],
        },
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
          accepts: [
            {
              asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } },
              amount: "0.05", // CC, where atomic units are expected
            },
          ],
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
          maxTimeoutSeconds: (req) => (req.path === "/slow" ? 600 : 30),
          accepts: [
            {
              asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } },
              amount: "500000000",
            },
          ],
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
        .set("PAYMENT-SIGNATURE", paymentHeader({ extra: { ...ECHOED_EXTRA, ...extra } }))
        .expect(200);
    });

    it("and refused when preSettle says so", async () => {
      stubFacilitator();
      const app = quoting({
        preSettle: ({ requirements }) =>
          requirements.extra.memo === "order-1" ? undefined : "policy_memo_unknown",
      });
      for (const extra of [{}, { memo: "someone-elses-order" }]) {
        const res = await request(app)
          .get("/paid")
          .set("PAYMENT-SIGNATURE", paymentHeader({ extra: { ...ECHOED_EXTRA, ...extra } }));
        expect(res.status).toBe(402);
        expect(res.body.error).toBe("policy_memo_unknown");
      }
    });
  });

  describe("preSettle", () => {
    it("sees the payment and its verified payer, and refuses before settle", async () => {
      // Before settle is the point: a refusal after it would have moved funds.
      const fetchMock = stubFacilitator();
      // Reads the payload's key rather than a payer of its own: the payload
      // names none. `payer` comes from verify, which is why the hook runs after
      // it — nothing could supply this field earlier.
      let seen: Record<string, unknown> = {};
      const app = makeApp({
        settle: true,
        preSettle: ({ payload, requirements, payer, verify }) => {
          seen = {
            publicKey: payload.payload.publicKey,
            payTo: requirements.payTo,
            payer,
            isValid: verify.isValid,
          };
          return "policy_order_closed";
        },
      });
      const res = await request(app).get("/paid").set("PAYMENT-SIGNATURE", paymentHeader());
      expect(res.status).toBe(402);
      expect(res.body.error).toBe("policy_order_closed");
      expect(seen).toEqual({
        publicKey: "pk",
        payTo: "merchant::x",
        payer: "alice::x",
        isValid: true,
      });
      const called = fetchMock.mock.calls.map(([url]) => String(url));
      expect(called.some((url) => url.includes("/v2/verify"))).toBe(true);
      expect(called.some((url) => url.includes("/v2/settle"))).toBe(false);
    });

    it("is not reached when verify refuses the payment", async () => {
      // The merchant is asked about payments the facilitator has vouched for.
      // A payment that never verified is the protocol's refusal, not theirs,
      // and handing it to merchant state would invite acting on a bad signature.
      stubFacilitator({ verify: { isValid: false, invalidReason: "bad_signature" } });
      const preSettle = vi.fn(() => undefined);
      const res = await request(makeApp({ settle: true, preSettle }))
        .get("/paid")
        .set("PAYMENT-SIGNATURE", paymentHeader());
      expect(res.status).toBe(402);
      expect(res.body.error).toBe("bad_signature");
      expect(preSettle).not.toHaveBeenCalled();
    });

    it("lets the payment through when it returns nothing", async () => {
      stubFacilitator();
      await request(makeApp({ preSettle: () => undefined }))
        .get("/paid")
        .set("PAYMENT-SIGNATURE", paymentHeader())
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
          accepts: [
            {
              asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } },
              amount: "500000000",
              executeBeforeSeconds: 300,
              memo: (req) => {
                const m = `invoice-${seen.length}${req.path}`;
                seen.push(m);
                return m;
              },
            },
          ],
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

  it("refuses a builder that returns no ways to pay", async () => {
    // Same reason an empty `accepts` is refused: a 402 advertising nothing is
    // a dead end the payer cannot act on.
    stubFacilitator();
    const res = await request(makeApp({ requirements: () => [] })).get("/paid");
    expect(res.status).toBe(500);
    expect(res.body.details).toMatch(/no ways to pay/);
  });

  it("describes the resource by path when the merchant names no description", async () => {
    stubFacilitator();
    const app = express();
    app.use(
      "/paid",
      paymentRequired({
        ...baseOptions,
        requirements: {
          network: "canton:x",
          payTo: "merchant::x",
          resource: "https://f.example/paid",
          accepts: [{ asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } }, amount: "500000000" }],
        },
      }),
    );
    app.get("/", (_req, res) => res.json({ ok: true }));
    const res = await request(app).get("/paid");
    expect(res.body.accepts[0].description).toBe("Access to /");
  });

  it("supports a full requirements builder function", async () => {
    stubFacilitator();
    const app = express();
    app.use(
      "/paid",
      paymentRequired({
        ...baseOptions,
        requirements: () => [{
          scheme: "exact",
          network: "canton:x",
          amount: "500000000",
          asset: "CC",
          extra: {
            assetTransferMethod: "transfer-factory",
            executeBeforeSeconds: 120,
            instrumentId: { id: "Amulet", admin: "DSO::x" },
          },
          payTo: "merchant::x",
          resource: "/r",
          description: "d",
          maxTimeoutSeconds: 60,
        }],
      }),
    );
    app.get("/paid", (_req, res) => res.json({ ok: true }));
    const res = await request(app).get("/paid");
    expect(res.status).toBe(402);
    // The builder owns the whole object: nothing is defaulted over it.
    expect(res.body.accepts[0]).toMatchObject({ resource: "/r", description: "d" });
  });

  it("responds 402 with well-formed requirements when there is no payment", async () => {
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
    const res = await request(makeApp()).get("/paid").set("PAYMENT-SIGNATURE", paymentHeader());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, payer: "alice::x", settled: false });
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("/v2/verify"))).toBe(true);
    expect(calls.some((u) => u.includes("/v2/settle"))).toBe(false);
  });

  it("takes the facilitator's verify.payer when there is one, without decoding the payload", async () => {
    stubFacilitator(); // verify answers payer "alice::x"
    const decode = vi.mocked(decodePayloadTransfer);
    const { decodePayloadTransfer: real } =
      await vi.importActual<typeof import("@chainsafe/x402-core")>("@chainsafe/x402-core");
    decode.mockClear();
    decode.mockImplementation(() => ({
      sender: "bob::1220",
      receiver: "merchant::x",
      amount: "0.05",
      instrumentId: { id: "Amulet", admin: "DSO::x" },
    }));
    try {
      const res = await request(makeApp()).get("/paid").set("PAYMENT-SIGNATURE", paymentHeader());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, payer: "alice::x" });
      expect(decode).not.toHaveBeenCalled();
    } finally {
      decode.mockImplementation(real);
    }
  });

  it("reads the payer from the signed transfer when verify leaves it out", async () => {
    // `payer` is optional in a verify response, and the payload names none.
    stubFacilitator({ verify: { isValid: true } });
    const decode = vi.mocked(decodePayloadTransfer);
    decode.mockClear();
    decode.mockReturnValueOnce({
      sender: "bob::1220",
      receiver: "merchant::x",
      amount: "0.05",
      instrumentId: { id: "Amulet", admin: "DSO::x" },
    });
    const res = await request(makeApp()).get("/paid").set("PAYMENT-SIGNATURE", paymentHeader());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, payer: "bob::1220" });
    // What gets decoded is the payload's own preparedTransaction.
    expect(decode).toHaveBeenCalledWith("b");
  });

  it("refuses before settling when verify names no payer and the transfer does not decode", async () => {
    const fetchMock = stubFacilitator({ verify: { isValid: true } });
    const decode = vi.mocked(decodePayloadTransfer);
    decode.mockClear();
    const onReject = vi.fn();
    const res = await request(makeApp({ settle: true, onReject }))
      .get("/paid")
      .set("PAYMENT-SIGNATURE", paymentHeader());
    expect(res.status).toBe(402);
    // Worded as the verifier words it: the spec's code, the older one beside it.
    expect(res.body).toMatchObject({
      error: "invalid_exact_canton_malformed_payload",
      details: "undecodable",
    });
    expect(onReject.mock.calls[0][0]).toMatchObject({
      reason: "invalid_exact_canton_malformed_payload",
      extensions: { reason: "transfer_mismatch", detail: "undecodable" },
    });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/v2/settle"))).toBe(false);
    // The real decoder ran on the payload's transaction and found no transfer in it.
    expect(decode).toHaveBeenCalledWith("b");
    expect(decode.mock.results[0]).toEqual({ type: "return", value: null });
  });

  it("refuses, rather than failing with a 500, a preparedTransaction that is not a string", async () => {
    // The header codec checks only that the inner payload is an object, so the
    // scheme's own guard is what catches this — before the payload is read,
    // and before the facilitator is asked.
    const fetchMock = stubFacilitator({ verify: { isValid: true } });
    const res = await request(makeApp())
      .get("/paid")
      .set("PAYMENT-SIGNATURE", paymentHeader({}, { preparedTransaction: 123 }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("policy_payload_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("responds 402 with the reason when verify is invalid", async () => {
    // The scheme spec's code reaches the merchant as the 402's `error`; the
    // code the facilitator answered with before it stays in extensions.reason.
    stubFacilitator({
      verify: {
        isValid: false,
        invalidReason: "invalid_exact_canton_amount_mismatch",
        extensions: { reason: "transfer_mismatch", detail: "amount" },
      },
    });
    const res = await request(makeApp()).get("/paid").set("PAYMENT-SIGNATURE", paymentHeader());
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ error: "invalid_exact_canton_amount_mismatch", details: "amount" });
  });

  it("forwards the facilitator's extensions.detail on a verify rejection", async () => {
    stubFacilitator({
      verify: {
        isValid: false,
        invalidReason: "internal_error",
        extensions: { detail: "authorization_amount_too_low", minAmountMicroUsdc: 2_000_000 },
      },
    });
    const res = await request(makeApp()).get("/paid").set("PAYMENT-SIGNATURE", paymentHeader());
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.details).toBe("authorization_amount_too_low");
  });

  it("omits details when the verify extensions.detail is not a string", async () => {
    stubFacilitator({
      verify: {
        isValid: false,
        invalidReason: "internal_error",
        extensions: { detail: { code: 1 } },
      },
    });
    const res = await request(makeApp()).get("/paid").set("PAYMENT-SIGNATURE", paymentHeader());
    expect(res.status).toBe(402);
    expect(res.body).not.toHaveProperty("details");
  });

  it("hands back a FRESH challenge (not the dead echoed one) on nonce_replayed", async () => {
    stubFacilitator({ verify: { isValid: false, invalidReason: "nonce_replayed" } });
    // The memo is what carries per-challenge identity now, so quoting one is
    // what makes "fresh" observably different from "echoed".
    let issued = 0;
    const app = makeApp({
      requirements: {
        ...(baseOptions.requirements as object),
        memo: () => `challenge-${++issued}`,
      } as never,
    });
    const res = await request(app)
      .get("/paid")
      .set("PAYMENT-SIGNATURE", paymentHeader({ extra: { ...ECHOED_EXTRA, memo: "spent-memo" } }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("nonce_replayed");
    // The echoed reference is spent; accepts[] must advertise a new one so a
    // retrying agent isn't looped on the dead challenge.
    expect(res.body.accepts[0].extra.memo).toBe("challenge-1");
    expect(res.body.accepts[0].extra.memo).not.toBe("spent-memo");
  });

  it("settles when settle mode is enabled and sets X-PAYMENT-RESPONSE", async () => {
    const fetchMock = stubFacilitator();
    const res = await request(makeApp({ settle: true }))
      .get("/paid")
      .set("PAYMENT-SIGNATURE", paymentHeader());
    expect(res.status).toBe(200);
    expect(res.body.settled).toBe(true);
    expect(res.headers["x-payment-response"]).toBe("upd-1");
    expect(
      fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.includes("/v2/settle")),
    ).toBe(true);
  });

  it("responds 402 bad_payload on an undecodable payment header", async () => {
    stubFacilitator();
    const res = await request(makeApp()).get("/paid").set("PAYMENT-SIGNATURE", "!!!not-base64-json!!!");
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("bad_payload");
  });

  it("rejects an echoed requirement that undercuts the merchant price", async () => {
    stubFacilitator();
    const res = await request(makeApp())
      .get("/paid")
      .set("PAYMENT-SIGNATURE", paymentHeader({ amount: "100000000" }));
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
        .set("PAYMENT-SIGNATURE", paymentHeader({ amount: bad }));
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
      .set("PAYMENT-SIGNATURE", paymentHeader({ amount: "" }));
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
        "PAYMENT-SIGNATURE",
        paymentHeader({
          extra: {
            assetTransferMethod: "transfer-factory",
            executeBeforeSeconds: 120,
            instrumentId: { id: "Amulet", admin: "DSO::impostor" },
          },
        }),
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
        "PAYMENT-SIGNATURE",
        paymentHeader({
          extra: {
            assetTransferMethod: "transfer-factory",
            executeBeforeSeconds: 120,
            instrumentId: { id: "USDCx", admin: "DSO::x" },
          },
        }),
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
      .set("PAYMENT-SIGNATURE", paymentHeader({ asset: "USDCx" }));
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
      .set("PAYMENT-SIGNATURE", paymentHeader({ extra: undefined }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("policy_requirements_invalid");
  });

  it("rejects a payment echoing a different payee", async () => {
    // The one field that decides who gets the money. Nothing else in the
    // request binds it: the signed transfer is checked against the ECHOED
    // requirement, so if that named another party and we did not compare it,
    // the merchant would verify a payment made to someone else.
    stubFacilitator();
    const res = await request(makeApp())
      .get("/paid")
      .set("PAYMENT-SIGNATURE", paymentHeader({ payTo: "attacker::x" }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("policy_payTo");
  });

  it("rejects a payment echoing a different scheme", async () => {
    stubFacilitator();
    const res = await request(makeApp())
      .get("/paid")
      .set("PAYMENT-SIGNATURE", paymentHeader({ scheme: "something-else" }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("policy_scheme");
  });

  it("rejects a payment echoing a different network", async () => {
    // A payment prepared against another synchronizer cannot settle here, and
    // the facilitator would refuse it — but refusing before verify costs a
    // round trip less and names the mismatch.
    stubFacilitator();
    const res = await request(makeApp())
      .get("/paid")
      .set("PAYMENT-SIGNATURE", paymentHeader({ network: "canton:elsewhere" }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("policy_network");
  });

  it("rejects a payment minted for a different resource (request↔payment binding)", async () => {
    // Same price/payTo/asset, but the payment was issued for another path — it
    // must not be replayable against this one.
    stubFacilitator();
    const res = await request(makeApp())
      .get("/paid")
      .set("PAYMENT-SIGNATURE", paymentHeader({ resource: "https://f.example/other" }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("policy_resource");
  });


  it("forwards exactly the payment's accepted to the facilitator as paymentRequirements", async () => {
    const fetchMock = stubFacilitator();
    const header = paymentHeader(
      { extra: { ...ECHOED_EXTRA, memo: "order-42" } },
      {},
      {
        resource: { url: "https://f.example/paid", description: "Access" },
        extensions: { "x-ext": { info: { a: 1 }, schema: {} } },
      },
    );
    const res = await request(makeApp({ settle: true })).get("/paid").set("PAYMENT-SIGNATURE", header);
    expect(res.status).toBe(200);
    const sent = JSON.parse(atob(header));
    for (const path of ["/v2/verify", "/v2/settle"]) {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes(path));
      const init = (call as unknown as [string, RequestInit] | undefined)?.[1];
      const body = JSON.parse(String(init?.body));
      expect(body.paymentRequirements).toEqual(sent.accepted);
      expect(body.paymentPayload).toEqual(sent);
    }
  });

  it("answers 402 bad_payload, not 500, for the pre-spec { payment, requirements } header", async () => {
    const fetchMock = stubFacilitator();
    const { accepted, ...rest } = JSON.parse(atob(paymentHeader()));
    const legacy = { payment: { ...rest, scheme: "exact", network: "canton:x" }, requirements: accepted };
    const res = await request(makeApp()).get("/paid").set("PAYMENT-SIGNATURE", btoa(JSON.stringify(legacy)));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("bad_payload");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 402 bad_payload, not 500, for a payment nested too deep to forward", async () => {
    // JSON.parse takes it, but JSON.stringify overflows the stack serialising
    // the facilitator request; the codec refuses it first.
    const fetchMock = stubFacilitator();
    const json = atob(paymentHeader());
    const deep = json.slice(0, -1) + `,"extensions":{"x":${"[".repeat(5000)}0${"]".repeat(5000)}}}`;
    const res = await request(makeApp()).get("/paid").set("PAYMENT-SIGNATURE", btoa(deep));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("bad_payload");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an EMPTY amount in accepted on decode, before policy", async () => {
    // BigInt("") is 0, so this one matters — but the codec's envelope check
    // catches it first (every PaymentRequirements has a non-empty amount), which
    // is why the code is bad_payload and not policy_amount_invalid. Asserted so
    // the earlier guard cannot quietly go.
    const fetchMock = stubFacilitator();
    const res = await request(makeApp())
      .get("/paid")
      .set("PAYMENT-SIGNATURE", paymentHeader({ amount: "" }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("bad_payload");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes an older facilitator's reason through as it came", async () => {
    stubFacilitator({ verify: { isValid: false, invalidReason: "bad_signature" } });
    const res = await request(makeApp()).get("/paid").set("PAYMENT-SIGNATURE", paymentHeader());
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("bad_signature");
  });

  describe("onReject", () => {
    it("reports a verify rejection with its details and full extensions", async () => {
      const extensions = {
        detail: "authorization_amount_too_low",
        minAmountMicroUsdc: 2_000_000,
        amountMicroUsdc: 5_000,
      };
      stubFacilitator({ verify: { isValid: false, invalidReason: "internal_error", extensions } });
      const onReject = vi.fn();
      await request(makeApp({ onReject })).get("/paid").set("PAYMENT-SIGNATURE", paymentHeader());
      expect(onReject).toHaveBeenCalledOnce();
      expect(onReject.mock.calls[0][0]).toEqual({
        status: 402,
        reason: "internal_error",
        details: "authorization_amount_too_low",
        extensions,
      });
    });

    it("names the payment a refusal is about, so preSettle's work can be undone", async () => {
      // The docs invite reserving stock in preSettle. When settle fails after
      // that, this is what says which order to release.
      stubFacilitator({
        settle: { success: false, errorReason: "execution_failed", errorDetails: "boom" },
      });
      const onReject = vi.fn();
      await request(makeApp({ settle: true, onReject }))
        .get("/paid")
        .set("PAYMENT-SIGNATURE", paymentHeader({ extra: { ...ECHOED_EXTRA, memo: "order-42" } }));
      const { payment } = onReject.mock.calls[0][0] as PaymentRejectionInfo;
      expect(payment?.requirements.extra.memo).toBe("order-42");
      expect(payment?.payer).toBe("alice::x");
      expect(payment?.payload.payload.publicKey).toBe("pk");
    });

    it("carries no payment when none was decoded", async () => {
      // A header that will not decode, and a 402 with no payment at all: there
      // is nothing to name, so the field is absent rather than half-filled.
      stubFacilitator();
      const onReject = vi.fn();
      await request(makeApp({ onReject })).get("/paid").set("PAYMENT-SIGNATURE", "!!!");
      expect(onReject.mock.calls[0][0]).not.toHaveProperty("payment");
    });

    it("carries no payment for a refusal before preSettle accepted", async () => {
      // The requirements are the payer's until verify has held them against
      // the signed transfer. An underpriced payment echoing another order's
      // reference must not hand that reference to a merchant whose undo would
      // then release someone else's order — and it costs the payer nothing,
      // since a refused payment never settles.
      stubFacilitator();
      const onReject = vi.fn();
      await request(makeApp({ settle: true, onReject }))
        .get("/paid")
        .set(
          "PAYMENT-SIGNATURE",
          paymentHeader({ amount: "1", extra: { ...ECHOED_EXTRA, memo: "someone-elses-order" } }),
        );
      const info = onReject.mock.calls[0][0] as PaymentRejectionInfo;
      expect(info.reason).toBe("policy_underpriced");
      expect(info).not.toHaveProperty("payment");
    });

    it("carries no payment when verify refuses it", async () => {
      // Nothing has been held against the transfer, so there is nothing a
      // merchant could owe an undo for.
      stubFacilitator({ verify: { isValid: false, invalidReason: "bad_signature" } });
      const onReject = vi.fn();
      await request(makeApp({ settle: true, onReject }))
        .get("/paid")
        .set("PAYMENT-SIGNATURE", paymentHeader({ extra: { ...ECHOED_EXTRA, memo: "order-42" } }));
      expect(onReject.mock.calls[0][0]).not.toHaveProperty("payment");
    });

    it("carries no payment when preSettle itself refuses", async () => {
      // preSettle refused, so it knows what it did and did not do; the
      // middleware naming the payment back at it would only invite an undo of
      // work that was never done.
      stubFacilitator();
      const onReject = vi.fn();
      await request(makeApp({ settle: true, onReject, preSettle: () => "policy_order_closed" }))
        .get("/paid")
        .set("PAYMENT-SIGNATURE", paymentHeader({ extra: { ...ECHOED_EXTRA, memo: "order-42" } }));
      const info = onReject.mock.calls[0][0] as PaymentRejectionInfo;
      expect(info.reason).toBe("policy_order_closed");
      expect(info).not.toHaveProperty("payment");
    });

    it("names the payment when a settle throws, 502 or not", async () => {
      // The other half of the undo case: settle did not answer at all. The
      // refusal still names what preSettle accepted.
      stubFacilitator();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          if (String(input).includes("/settle")) throw new Error("connection reset");
          return new Response(JSON.stringify({ isValid: true, payer: "alice::x" }), {
            headers: { "content-type": "application/json" },
          });
        }),
      );
      const onReject = vi.fn();
      const res = await request(makeApp({ settle: true, onReject }))
        .get("/paid")
        .set("PAYMENT-SIGNATURE", paymentHeader({ extra: { ...ECHOED_EXTRA, memo: "order-42" } }));
      expect(res.status).toBe(502);
      const { payment } = onReject.mock.calls[0][0] as PaymentRejectionInfo;
      expect(payment?.requirements.extra.memo).toBe("order-42");
      expect(payment?.payer).toBe("alice::x");
    });

    it("reports a settle rejection", async () => {
      stubFacilitator({
        settle: { success: false, errorReason: "execution_failed", errorDetails: "boom" },
      });
      const onReject = vi.fn();
      const res = await request(makeApp({ settle: true, onReject }))
        .get("/paid")
        .set("PAYMENT-SIGNATURE", paymentHeader());
      expect(res.status).toBe(402);
      expect(onReject.mock.calls[0][0]).toMatchObject({
        status: 402,
        reason: "execution_failed",
        details: "boom",
      });
    });

    it("reports a policy rejection", async () => {
      stubFacilitator();
      const onReject = vi.fn();
      await request(makeApp({ onReject }))
        .get("/paid")
        .set("PAYMENT-SIGNATURE", paymentHeader({ amount: "100000000" }));
      expect(onReject.mock.calls[0][0]).toMatchObject({
        status: 402,
        reason: "policy_underpriced",
      });
    });

    it("reports a facilitator error with the underlying error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("down", { status: 503 })),
      );
      const onReject = vi.fn();
      const res = await request(makeApp({ onReject }))
        .get("/paid")
        .set("PAYMENT-SIGNATURE", paymentHeader());
      expect(res.status).toBe(502);
      expect(onReject.mock.calls[0][0]).toMatchObject({ status: 502, reason: "facilitator_error" });
      expect(onReject.mock.calls[0][0].error).toBeInstanceOf(Error);
    });

    it("is not called for the plain challenge or a paid request", async () => {
      stubFacilitator();
      const onReject = vi.fn();
      const app = makeApp({ onReject });
      expect((await request(app).get("/paid")).status).toBe(402);
      expect((await request(app).get("/paid").set("PAYMENT-SIGNATURE", paymentHeader())).status).toBe(200);
      expect(onReject).not.toHaveBeenCalled();
    });

    it("still sends the response when the hook throws", async () => {
      stubFacilitator({ verify: { isValid: false, invalidReason: "bad_signature" } });
      const onReject = vi.fn(() => {
        throw new Error("logger down");
      });
      const res = await request(makeApp({ onReject }))
        .get("/paid")
        .set("PAYMENT-SIGNATURE", paymentHeader());
      expect(res.status).toBe(402);
      expect(res.body.error).toBe("bad_signature");
    });

    it("swallows a rejected promise from an async hook", async () => {
      stubFacilitator({ verify: { isValid: false, invalidReason: "bad_signature" } });
      const onReject = vi.fn(async () => {
        throw new Error("remote logger down");
      });
      const res = await request(makeApp({ onReject }))
        .get("/paid")
        .set("PAYMENT-SIGNATURE", paymentHeader());
      expect(res.status).toBe(402);
      // Let the hook's promise settle; vitest fails the run on an unhandled rejection.
      await new Promise((r) => setImmediate(r));
      expect(onReject).toHaveBeenCalledOnce();
    });
  });
});

describe("paymentRequired: which quote a payment is for", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A second way to pay, priced separately and in its own instrument. */
  const ALT_EXTRA = {
    assetTransferMethod: "transfer-factory",
    executeBeforeSeconds: 120,
    instrumentId: { id: "USDCx", admin: "ISSUER::x" },
  };

  /** The same terms, offering both — each entry a spec, neither privileged. */
  const twoWays: Partial<PaymentRequiredOptions> = {
    requirements: {
      network: "canton:x",
      payTo: "merchant::x",
      resource: "https://f.example/paid",
      accepts: [
        { asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } }, amount: "500000000" },
        { asset: { instrumentId: { id: "USDCx", admin: "ISSUER::x" } }, amount: "250000000" },
      ],
    },
  };

  it("lets an entry override a shared field, rather than the shared one always winning", async () => {
    // Shared terms describe the sale; an entry may still differ — a second
    // instrument settling to another party, say. Without this the shared value
    // would silently overwrite what the entry asked for.
    stubFacilitator();
    const app = makeApp({
      requirements: {
        network: "canton:x",
        payTo: "merchant::shared",
        resource: "https://f.example/paid",
        accepts: [
          { asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } }, amount: "500000000" },
          {
            asset: { instrumentId: { id: "USDCx", admin: "ISSUER::x" } },
            amount: "250000000",
            payTo: "merchant::other",
            maxTimeoutSeconds: 120,
          },
        ],
      },
    });
    const res = await request(app).get("/paid");
    const [first, second] = res.body.accepts as CantonPaymentRequirements[];
    expect(first.payTo).toBe("merchant::shared");
    expect(second.payTo).toBe("merchant::other");
    expect(first.maxTimeoutSeconds).toBe(60);
    expect(second.maxTimeoutSeconds).toBe(120);
  });

  it("refuses to start with no ways to pay", async () => {
    // A 402 that advertises nothing is not a challenge; it is a dead end the
    // payer cannot act on. Merchant config, so it throws when the route is
    // mounted rather than answering 500 to every request.
    expect(() =>
      makeApp({
        requirements: {
          network: "canton:x",
          payTo: "merchant::x",
          resource: "https://f.example/paid",
          accepts: [],
        },
      }),
    ).toThrow(/must advertise a way to pay/);
  });

  it("accepts a payment made against the second way to pay, not just the first", async () => {
    // Before this the echoed requirement was held against one quote alone, so
    // paying an advertised alternative was refused as underpriced.
    stubFacilitator();
    const app = makeApp(twoWays);
    const res = await request(app)
      .get("/paid")
      .set("PAYMENT-SIGNATURE", paymentHeader({ amount: "250000000", asset: "USDCx", extra: ALT_EXTRA }));
    expect(res.status).toBe(200);
    expect(res.body.payer).toBe("alice::x");
  });

  it("still accepts a payment made against the first way when a second is advertised", async () => {
    stubFacilitator();
    const app = makeApp(twoWays);
    const res = await request(app).get("/paid").set("PAYMENT-SIGNATURE", paymentHeader());
    expect(res.status).toBe(200);
  });

  it("advertises every quote in accepts[]", async () => {
    stubFacilitator();
    const app = makeApp(twoWays);
    const res = await request(app).get("/paid");
    expect(res.status).toBe(402);
    expect(res.body.accepts.map((a: CantonPaymentRequirements) => a.asset)).toEqual([
      "CC",
      "USDCx",
    ]);
  });

  it("refuses a payment that matches no advertised quote, reporting the nearest miss", async () => {
    // Underpaying the alternative matches its scheme/network/payTo/resource/asset
    // and fails on price; against the primary it fails earlier, on asset. The
    // reported reason is the one from the quote it got furthest through, so the
    // payer is told the thing that actually stopped it.
    stubFacilitator();
    const app = makeApp(twoWays);
    const res = await request(app)
      .get("/paid")
      .set("PAYMENT-SIGNATURE", paymentHeader({ amount: "1", asset: "USDCx", extra: ALT_EXTRA }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("policy_underpriced");
  });

  it("rejects an echoed executeBeforeSeconds the merchant did not quote", async () => {
    // It reaches the ledger as the transfer's executeBefore, so echoing another
    // value is the payer choosing how long the quote stays settleable.
    stubFacilitator();
    const res = await request(makeApp())
      .get("/paid")
      .set("PAYMENT-SIGNATURE", paymentHeader({ extra: { ...ECHOED_EXTRA, executeBeforeSeconds: 99999 } }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("policy_execute_before");
  });

  it("rejects an echoed assetTransferMethod that is not the reserved one", async () => {
    stubFacilitator();
    const res = await request(makeApp())
      .get("/paid")
      .set(
        "PAYMENT-SIGNATURE",
        paymentHeader({ extra: { ...ECHOED_EXTRA, assetTransferMethod: "something-else" } }),
      );
    expect(res.status).toBe(402);
    // Caught by the guard before the field comparison — the schema pins it to a
    // literal — so the code is the guard's, not policy_transfer_method.
    expect(res.body.error).toBe("policy_requirements_invalid");
  });

  it("ignores description, which never reaches the ledger", async () => {
    // Explicitly skipped rather than forgotten: a payer library that normalises
    // or drops it still pays.
    stubFacilitator();
    const res = await request(makeApp())
      .get("/paid")
      .set("PAYMENT-SIGNATURE", paymentHeader({ description: "whatever it likes" }));
    expect(res.status).toBe(200);
  });

  it("refuses an accepted whose maxTimeoutSeconds is not the merchant's", async () => {
    // The facilitator holds a payment for at most this long; a payer echoing a
    // longer one is choosing how long its own payment stays live.
    const fetchMock = stubFacilitator();
    const res = await request(makeApp())
      .get("/paid")
      .set("PAYMENT-SIGNATURE", paymentHeader({ maxTimeoutSeconds: 7 }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("policy_timeout");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("paymentRequired: minting a merchant reference", () => {
  afterEach(() => vi.unstubAllGlobals());

  function appRecording(booked: string[], over: Partial<PaymentRequiredOptions> = {}): Express {
    const app = express();
    app.use(
      "/paid",
      paymentRequired({
        ...baseOptions,
        requirements: {
          network: "canton:x",
          payTo: "merchant::x",
          resource: "https://f.example/paid",
          accepts: [
            {
              asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } },
              amount: "500000000",
              memo: () => {
                const m = `order-${booked.length}`;
                booked.push(m);
                return m;
              },
            },
          ],
        },
        ...over,
      }),
    );
    app.get("/paid", (_req, res) => res.json({ ok: true }));
    return app;
  }

  it("mints once per challenge issued, and NOT on a request that pays one", async () => {
    // The generator is documented to record what it issues, so a successful
    // payment minting another reference books a second order for one sale.
    stubFacilitator();
    const booked: string[] = [];
    const app = appRecording(booked, { settle: true });

    const challenge = await request(app).get("/paid");
    expect(booked).toEqual(["order-0"]);

    const paid = await request(app)
      .get("/paid")
      .set(
        "PAYMENT-SIGNATURE",
        paymentHeader({ extra: { ...ECHOED_EXTRA, memo: challenge.body.accepts[0].extra.memo } }),
      );

    expect(paid.status).toBe(200);
    expect(booked).toEqual(["order-0"]);
  });

  it("mints a new one for a rejected payment, which needs terms it can pay", async () => {
    stubFacilitator({ verify: { isValid: false, invalidReason: "nonce_replayed" } });
    const booked: string[] = [];
    const res = await request(appRecording(booked))
      .get("/paid")
      .set("PAYMENT-SIGNATURE", paymentHeader({ extra: { ...ECHOED_EXTRA, memo: "order-stale" } }));

    expect(res.status).toBe(402);
    expect(res.body.accepts[0].extra.memo).toBe("order-0");
    expect(booked).toEqual(["order-0"]);
  });

  it("does not mint when the payment is refused before the facilitator is asked", async () => {
    // A policy refusal still has to hand back a payable quote, so it mints one
    // — but exactly one, and no verify was spent to find out.
    const fetchMock = stubFacilitator();
    const booked: string[] = [];
    const res = await request(appRecording(booked))
      .get("/paid")
      .set("PAYMENT-SIGNATURE", paymentHeader({ amount: "1" }));

    expect(res.status).toBe(402);
    expect(res.body.error).toBe("policy_underpriced");
    expect(booked).toEqual(["order-0"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 500, not 402, when the reference generator itself throws", async () => {
    // There is no quote to advertise, so it cannot be a 402.
    stubFacilitator();
    const app = express();
    app.use(
      "/paid",
      paymentRequired({
        ...baseOptions,
        requirements: {
          network: "canton:x",
          payTo: "merchant::x",
          resource: "https://f.example/paid",
          accepts: [
            {
              asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } },
              amount: "500000000",
              memo: () => {
                throw new Error("order store is down");
              },
            },
          ],
        },
      }),
    );
    const res = await request(app).get("/paid");
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      error: "x402_middleware_error",
      details: "order store is down",
    });
  });
});

describe("paymentRequired: configuring from /v2/supported", () => {
  afterEach(() => vi.unstubAllGlobals());

  const DSO = "DSO::1220be58";
  const SUPPORTED = {
    kinds: [
      {
        x402Version: 2,
        scheme: "exact",
        network: "canton:devnet",
        extra: {
          transferMethods: ["transfer-factory"],
          synchronizerId: "global-domain::1220be58",
          carriages: ["inline"],
          instruments: [{ admin: DSO, instrumentId: { id: "Amulet", admin: DSO }, symbol: "CC" }],
        },
      },
    ],
  };

  /** A facilitator that also answers discovery. */
  function stubWithSupported(supported: unknown = SUPPORTED) {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/v2/supported")) return json(supported);
      if (url.includes("/v2/verify")) return json({ isValid: true, payer: "alice::x" });
      if (url.includes("/v2/settle"))
        return json({
          success: true,
          network: "canton:devnet",
          transaction: "upd-1",
          payer: "alice::x",
        });
      return new Response("no route", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  /** A merchant that states only its own business: who is paid, and how much. */
  function discoveringApp(over: Partial<PaymentRequiredOptions> = {}): Express {
    const app = express();
    app.use(
      "/paid",
      paymentRequired({
        facilitator: new FacilitatorClient("https://f.example", { apiKey: "k" }),
        requirements: {
          payTo: "merchant::x",
          resource: "https://f.example/paid",
          // Names the instrument, not the whole asset: the registry admin still
          // comes from /v2/supported, which is what these tests are about.
          accepts: [{ amount: "500000000", asset: "Amulet" }],
        },
        ...over,
      }),
    );
    app.get("/paid", (req, res) => res.json({ ok: true, payer: req.x402?.payer }));
    return app;
  }

  it("quotes the network, instrument and symbol the facilitator advertises", async () => {
    stubWithSupported();
    const res = await request(discoveringApp()).get("/paid");
    expect(res.status).toBe(402);
    const [quote] = res.body.accepts;
    expect(quote.network).toBe("canton:devnet");
    expect(quote.asset).toBe("CC");
    // The admin is the party the facilitator validates the holding against —
    // read from the facilitator, so there is no second copy to keep true.
    expect(quote.extra.instrumentId).toEqual({ id: "Amulet", admin: DSO });
  });

  it("produces a quote a payer would accept as well-formed", async () => {
    stubWithSupported();
    const res = await request(discoveringApp()).get("/paid");
    expect(isCantonPaymentRequirements(res.body.accepts[0])).toBe(true);
  });

  it("fetches /v2/supported once across many requests, not once per request", async () => {
    const fetchMock = stubWithSupported();
    const app = discoveringApp();
    await request(app).get("/paid");
    await request(app).get("/paid");
    await request(app).get("/paid");
    const discovery = fetchMock.mock.calls.filter(([url]) => String(url).includes("/v2/supported"));
    expect(discovery).toHaveLength(1);
  });


  it("narrows discovery by a pinned asset, as it does by a named one", async () => {
    // The richer form must not do less: an AssetSpec says which instrument as
    // surely as a string id does, so the network discovered has to be one
    // that settles it. Both forms quote the same terms here.
    const both = {
      kinds: [
        {
          ...SUPPORTED.kinds[0],
          extra: {
            ...SUPPORTED.kinds[0].extra,
            instruments: [
              { admin: DSO, instrumentId: { id: "Amulet", admin: DSO }, symbol: "CC" },
              { admin: "ISSUER::x", instrumentId: { id: "USDCx", admin: "ISSUER::x" }, symbol: "USDCx" },
            ],
          },
        },
      ],
    };
    for (const asset of ["Amulet", { instrumentId: { id: "Amulet", admin: DSO } }] as const) {
      stubWithSupported(both);
      const app = express();
      app.use(
        "/paid",
        paymentRequired({
          facilitator: new FacilitatorClient("https://f.example", { apiKey: "k" }),
          // No `network`: it is discovered, and the pinned asset must narrow it.
          requirements: { payTo: "merchant::x", resource: "https://f.example/paid", accepts: [{ amount: "1", asset }] },
        }),
      );
      app.get("/paid", (_q, r) => r.json({ ok: true }));
      const res = await request(app).get("/paid");
      expect(res.status).toBe(402);
      expect(res.body.accepts).toHaveLength(1);
      expect(res.body.accepts[0].asset).toBe("CC");
      expect(res.body.accepts[0].extra.instrumentId).toEqual({ id: "Amulet", admin: DSO });
    }
  });

  it("never calls /v2/supported when the merchant pins both fields", async () => {
    // Pinning stays a zero-dependency path: no cold-start round trip, and no
    // facilitator outage between the merchant and its own 402.
    const fetchMock = stubWithSupported();
    await request(makeApp()).get("/paid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("verifies a payment made against a discovered quote", async () => {
    stubWithSupported();
    const app = discoveringApp();
    const challenge = await request(app).get("/paid");
    const quote = challenge.body.accepts[0];
    const res = await request(app)
      .get("/paid")
      .set(
        "PAYMENT-SIGNATURE",
        paymentHeader({ network: "canton:devnet", asset: "CC", extra: quote.extra }),
      );
    expect(res.status).toBe(200);
    expect(res.body.payer).toBe("alice::x");
  });

  it("answers 500 naming the choice when the facilitator settles several networks", async () => {
    // Choosing for the merchant would be choosing what it charges on.
    stubWithSupported({
      kinds: [SUPPORTED.kinds[0], { ...SUPPORTED.kinds[0], network: "canton:mainnet" }],
    });
    const res = await request(discoveringApp()).get("/paid");
    expect(res.status).toBe(500);
    expect(res.body.details).toContain("canton:mainnet");
  });

  it("takes the merchant's network as the choice when it settles several", async () => {
    stubWithSupported({
      kinds: [SUPPORTED.kinds[0], { ...SUPPORTED.kinds[0], network: "canton:mainnet" }],
    });
    const res = await request(
      discoveringApp({
        requirements: {
          payTo: "merchant::x",
          resource: "https://f.example/paid",
          network: "canton:mainnet",
          accepts: [{ amount: "500000000", asset: "Amulet" }],
        },
      }),
    ).get("/paid");
    expect(res.status).toBe(402);
    expect(res.body.accepts[0].network).toBe("canton:mainnet");
  });

  it("answers 500 naming the networks when the facilitator settles the instrument on several", async () => {
    // An entry always names its instrument, so that dimension cannot be
    // ambiguous — but the network still can, and a price means nothing without
    // knowing which chain it settles on either.
    stubWithSupported({
      kinds: [
        SUPPORTED.kinds[0],
        { ...SUPPORTED.kinds[0], network: "canton:mainnet" },
      ],
    });
    const res = await request(discoveringApp()).get("/paid");
    expect(res.status).toBe(500);
    expect(res.body.details).toContain("canton:devnet");
    expect(res.body.details).toContain("canton:mainnet");
    // Worded for the merchant: the fix is in its own config, so name the fields
    // it writes rather than core's parameters.
    expect(res.body.details).toContain("network");
  });

  it("answers 500 naming what it does settle when the entry's instrument is not one", async () => {
    // The merchant named an instrument; the facilitator does not carry it.
    // Config, not a payer's doing, so it fails loudly rather than quoting
    // something else.
    stubWithSupported();
    const app = express();
    app.use(
      "/paid",
      paymentRequired({
        facilitator: new FacilitatorClient("https://f.example", { apiKey: "k" }),
        requirements: {
          payTo: "merchant::x",
          resource: "https://f.example/paid",
          accepts: [{ amount: "250000", asset: "GBPx" }],
        },
      }),
    );
    app.get("/paid", (_q, r) => r.json({ ok: true }));
    const res = await request(app).get("/paid");
    expect(res.status).toBe(500);
    expect(res.body.details).toContain("GBPx");
    expect(res.body.details).toContain("Amulet");
  });

  it("takes the merchant's instrument as the choice when it settles several", async () => {
    stubWithSupported({
      kinds: [
        {
          ...SUPPORTED.kinds[0],
          extra: {
            ...SUPPORTED.kinds[0].extra,
            instruments: [
              { instrumentId: { id: "Amulet", admin: DSO } },
              { instrumentId: { id: "USDCx", admin: "ISSUER::x" }, symbol: "USDCx" },
            ],
          },
        },
      ],
    });
    const res = await request(
      discoveringApp({
        requirements: {
          payTo: "merchant::x",
          resource: "https://f.example/paid",
          accepts: [
            {
              amount: "500000000",
              asset: "USDCx",
            },
          ],
        },
      }),
    ).get("/paid");
    expect(res.status).toBe(402);
    expect(res.body.accepts[0].extra.instrumentId).toEqual({ id: "USDCx", admin: "ISSUER::x" });
  });

  it("answers 502 when the facilitator cannot be reached for discovery", async () => {
    // A FacilitatorError is the facilitator's fault, not the merchant's config.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "down" }, 503)),
    );
    const res = await request(discoveringApp()).get("/paid");
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("facilitator_error");
  });

  describe("the payment header's name", () => {
    it("still reads X-PAYMENT, the name this SDK used before the spec's", async () => {
      const fetchMock = stubFacilitator();
      const res = await request(makeApp()).get("/paid").set("X-PAYMENT", paymentHeader());
      expect(res.status).toBe(200);
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/v2/verify"))).toBe(true);
    });

    it("takes PAYMENT-SIGNATURE over X-PAYMENT when a request carries both", async () => {
      stubFacilitator();
      const res = await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", paymentHeader())
        .set("X-PAYMENT", "!!!not-base64-json!!!");
      expect(res.status).toBe(200);
      const refused = await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", "!!!not-base64-json!!!")
        .set("X-PAYMENT", paymentHeader());
      expect(refused.status).toBe(402);
      expect(refused.body.error).toBe("bad_payload");
    });

    it("falls back to X-PAYMENT when PAYMENT-SIGNATURE is empty", async () => {
      stubFacilitator();
      const res = await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", "")
        .set("X-PAYMENT", paymentHeader());
      expect(res.status).toBe(200);
    });

    it("reads the header whatever its case, as HTTP does", async () => {
      stubFacilitator();
      const res = await request(makeApp()).get("/paid").set("payment-signature", paymentHeader());
      expect(res.status).toBe(200);
    });
  });

  describe("PAYMENT-REQUIRED", () => {
    /** What a client does with the header: base64 -> UTF-8 -> JSON. */
    const header = (res: { headers: Record<string, string> }): Record<string, unknown> =>
      JSON.parse(Buffer.from(res.headers["payment-required"], "base64").toString("utf8"));

    it("carries the spec's PaymentRequired, and the body is the same object", async () => {
      stubFacilitator();
      const res = await request(makeApp()).get("/paid");
      expect(res.status).toBe(402);
      const sent = header(res);
      expect(isCantonPaymentRequiredResponse(sent)).toBe(true);
      expect(sent).toEqual(res.body);
      expect(Object.keys(sent).sort()).toEqual(["accepts", "error", "resource", "x402Version"]);
    });

    it("names the resource the terms were quoted for: the request URL and description by default", async () => {
      stubFacilitator();
      const app = express();
      const { resource: _omit, ...spec } = baseOptions.requirements as RequirementsSpec;
      app.use("/paid", paymentRequired({ ...baseOptions, requirements: spec }));
      app.get("/paid", (_req, res) => res.json({ ok: true }));
      const res = await request(app).get("/paid?item=7");
      const { resource, accepts } = header(res) as {
        resource: Record<string, unknown>;
        accepts: CantonPaymentRequirements[];
      };
      expect(resource.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/paid\?item=7$/);
      expect(resource).toEqual({ url: accepts[0].resource, description: accepts[0].description });
      expect(res.body.resource).toEqual(resource);
    });

    it("takes a builder's resource and description, and leaves description out when it has none", async () => {
      stubFacilitator();
      const built = {
        scheme: "exact",
        network: "canton:x",
        amount: "500000000",
        asset: "CC",
        extra: {
          assetTransferMethod: "transfer-factory",
          executeBeforeSeconds: 120,
          instrumentId: { id: "Amulet", admin: "DSO::x" },
        },
        payTo: "merchant::x",
        resource: "https://merchant.example/report",
        maxTimeoutSeconds: 60,
      } as CantonPaymentRequirements;
      for (const [requirements, expected] of [
        [
          { ...built, description: "A report" },
          { url: "https://merchant.example/report", description: "A report" },
        ],
        [built, { url: "https://merchant.example/report" }],
      ] as const) {
        const app = express();
        app.use("/paid", paymentRequired({ ...baseOptions, requirements: () => [requirements] }));
        app.get("/paid", (_req, res) => res.json({ ok: true }));
        expect(header(await request(app).get("/paid")).resource).toEqual(expected);
      }
    });

    it("goes on a rejection's 402 too, with its code; details stay in the body", async () => {
      stubFacilitator({
        verify: { isValid: false, invalidReason: "transfer_mismatch", extensions: { detail: "amount" } },
      });
      const res = await request(makeApp()).get("/paid").set("PAYMENT-SIGNATURE", paymentHeader());
      expect(res.status).toBe(402);
      expect(res.body).toMatchObject({ error: "transfer_mismatch", details: "amount" });
      const sent = header(res);
      expect(sent.error).toBe("transfer_mismatch");
      expect(sent).not.toHaveProperty("details");
      const { details: _omit, ...spec } = res.body;
      expect(sent).toEqual(spec);
      // A client reading the body with the guard still gets a PaymentRequired.
      expect(isCantonPaymentRequiredResponse(res.body)).toBe(true);
    });

    it("lists every way to pay, in the order the terms name them", async () => {
      // Two entries, advertised in the order the terms list them.
      stubFacilitator();
      const spec = baseOptions.requirements as RequirementsSpec;
      const app = express();
      app.use(
        "/paid",
        paymentRequired({
          ...baseOptions,
          requirements: {
            ...spec,
            accepts: [
              ...spec.accepts,
              // A second INSTRUMENT, not a second price for the first: two
              // entries alike but for `amount` are refused, since a payer
              // could only choose between them on price.
              {
                amount: "700000000",
                asset: { instrumentId: { id: "USDCx", admin: "ISSUER::x" } },
              },
            ],
          },
        }),
      );
      app.get("/paid", (_req, res) => res.json({ ok: true }));
      const res = await request(app).get("/paid");
      const accepts = header(res).accepts as CantonPaymentRequirements[];
      expect(accepts.map((a) => a.amount)).toEqual(["500000000", "700000000"]);
      expect(accepts).toEqual(res.body.accepts);
    });

    it("is not sent when the answer is not a 402", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("down", { status: 503 })),
      );
      const failed = await request(makeApp()).get("/paid").set("PAYMENT-SIGNATURE", paymentHeader());
      expect(failed.status).toBe(502);
      expect(failed.headers).not.toHaveProperty("payment-required");
      stubFacilitator();
      const paid = await request(makeApp()).get("/paid").set("PAYMENT-SIGNATURE", paymentHeader());
      expect(paid.status).toBe(200);
      expect(paid.headers).not.toHaveProperty("payment-required");
    });
  });


  it("refuses two ways to pay in the same asset, when the route is mounted", async () => {
    // Merchant config, so it throws at paymentRequired() — not once per
    // request, and without asking the facilitator anything.
    const fetchMock = stubWithSupported();
    expect(() =>
      paymentRequired({
        facilitator: new FacilitatorClient("https://f.example", { apiKey: "k" }),
        requirements: {
          payTo: "merchant::x",
          resource: "https://f.example/paid",
          accepts: [
            { amount: "500000000", asset: "Amulet" },
            { amount: "250000", asset: "Amulet" },
          ],
        },
      }),
    ).toThrow(/ways to pay 1 and 2 are both in Amulet/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("catches it across the two ways of naming one asset", async () => {
    // One names the instrument by id, the other pins it whole. Both normalise
    // to the same id without a request.
    stubWithSupported();
    expect(() =>
      paymentRequired({
        facilitator: new FacilitatorClient("https://f.example", { apiKey: "k" }),
        requirements: {
          payTo: "merchant::x",
          resource: "https://f.example/paid",
          accepts: [
            { amount: "500000000", asset: "Amulet" },
            { amount: "250000", asset: { instrumentId: { id: "Amulet", admin: DSO } } },
          ],
        },
      }),
    ).toThrow(/both in Amulet/);
  });

  it("does not check an entry whose asset is a resolver", async () => {
    // Nothing to compare until a request arrives, so it mounts.
    stubWithSupported();
    expect(() =>
      paymentRequired({
        facilitator: new FacilitatorClient("https://f.example", { apiKey: "k" }),
        requirements: {
          payTo: "merchant::x",
          resource: "https://f.example/paid",
          accepts: [
            { amount: "500000000", asset: "Amulet" },
            { amount: "250000", asset: () => "Amulet" },
          ],
        },
      }),
    ).not.toThrow();
  });

  it("allows two ways to pay that differ by instrument", async () => {
    stubWithSupported({
      kinds: [
        {
          ...SUPPORTED.kinds[0],
          extra: {
            ...SUPPORTED.kinds[0].extra,
            instruments: [
              { admin: DSO, instrumentId: { id: "Amulet", admin: DSO }, symbol: "CC" },
              { admin: "ISSUER::x", instrumentId: { id: "USDCx", admin: "ISSUER::x" }, symbol: "USDCx" },
            ],
          },
        },
      ],
    });
    const app = express();
    app.use(
      "/paid",
      paymentRequired({
        facilitator: new FacilitatorClient("https://f.example", { apiKey: "k" }),
        requirements: {
          payTo: "merchant::x",
          resource: "https://f.example/paid",
          accepts: [
            { amount: "500000000", asset: "Amulet" },
            { amount: "250000", asset: "USDCx" },
          ],
        },
      }),
    );
    app.get("/paid", (_q, r) => r.json({ ok: true }));
    const res = await request(app).get("/paid");
    expect(res.status).toBe(402);
    expect(res.body.accepts.map((a: { asset: string }) => a.asset)).toEqual(["CC", "USDCx"]);
  });


  describe("a way to pay that names no asset", () => {
    // TypeScript refuses this at the call site (options.types.test.ts). What is
    // left is JavaScript, and a resolver that returns nothing — both reached
    // the instrument id as a property of `undefined`.
    const mount = (asset: unknown) =>
      paymentRequired({
        facilitator: new FacilitatorClient("https://f.example", { apiKey: "k" }),
        requirements: {
          payTo: "merchant::x",
          resource: "https://f.example/paid",
          network: "canton:devnet",
          accepts: [{ amount: "500000000", ...(asset === undefined ? {} : { asset }) }],
        },
      } as unknown as Parameters<typeof paymentRequired>[0]);

    it("is a TermsError at mount, not a TypeError about instrumentId", () => {
      expect(() => mount(undefined)).toThrow(TermsError);
      expect(() => mount(undefined)).toThrow(/names no `asset`/);
    });

    it("is a TermsError when a resolver returns nothing, and is never skipped", async () => {
      // A resolver cannot be read at mount, so this one arrives per request —
      // where a way to pay that merely fails to quote is dropped and the rest
      // are offered. The good entry beside it is what makes that visible:
      // skipping would answer 402 with it alone. Merchant config is not a
      // quoting failure, so the request fails instead.
      stubWithSupported();
      const onReject = vi.fn();
      const app = express();
      app.use(
        "/paid",
        paymentRequired({
          facilitator: new FacilitatorClient("https://f.example", { apiKey: "k" }),
          onReject,
          requirements: {
            payTo: "merchant::x",
            resource: "https://f.example/paid",
            network: "canton:devnet",
            accepts: [
              { amount: "500000000", asset: "Amulet" },
              { amount: "250000", asset: () => undefined as unknown as string },
            ],
          },
        }),
      );
      const res = await request(app).get("/paid");
      expect(res.status).toBe(500);
      const { error } = onReject.mock.calls[0][0] as PaymentRejectionInfo;
      expect(error).toBeInstanceOf(TermsError);
      expect((error as Error).message).toMatch(/names no `asset`/);
    });
  });

  describe("a way to pay that cannot be quoted", () => {
    const twoEntries = (onQuoteError?: (e: Error) => void) => {
      const app = express();
      app.use(
        "/paid",
        paymentRequired({
          facilitator: new FacilitatorClient("https://f.example", { apiKey: "k" }),
          ...(onQuoteError ? { onQuoteError } : {}),
          requirements: {
            payTo: "merchant::x",
            resource: "https://f.example/paid",
            network: "canton:devnet",
            accepts: [
              { amount: "500000000", asset: "Amulet" },
              // The deployment does not carry this one.
              { amount: "250000", asset: "GBPx" },
            ],
          },
        }),
      );
      app.get("/paid", (req, res) => res.json({ ok: true, payer: req.x402?.payer }));
      return app;
    };

    it("is left out of the 402, and the others are still offered", async () => {
      stubWithSupported();
      const res = await request(twoEntries()).get("/paid");
      expect(res.status).toBe(402);
      expect(res.body.accepts.map((a: { asset: string }) => a.asset)).toEqual(["CC"]);
    });

    it("does not stop a payment for one that can", async () => {
      // The point of not failing the whole route: a payer holding good terms
      // is paying, and a sibling entry's trouble is not its concern.
      stubWithSupported();
      const res = await request(twoEntries())
        .get("/paid")
        .set(
          "PAYMENT-SIGNATURE",
          paymentHeader({
            network: "canton:devnet",
            asset: "CC",
            extra: {
              assetTransferMethod: "transfer-factory",
              executeBeforeSeconds: 120,
              instrumentId: { id: "Amulet", admin: DSO },
            },
          }),
        );
      expect(res.status).toBe(200);
      expect(res.body.payer).toBe("alice::x");
    });

    it("tells the merchant through onQuoteError, naming the entry", async () => {
      stubWithSupported();
      const seen: string[] = [];
      await request(twoEntries((e) => seen.push(e.message))).get("/paid");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatch(/way to pay 2/);
      expect(seen[0]).toMatch(/GBPx/);
    });

    it("still answers when the hook throws", async () => {
      stubWithSupported();
      const res = await request(
        twoEntries(() => {
          throw new Error("logger down");
        }),
      ).get("/paid");
      expect(res.status).toBe(402);
    });

    it("fails the request when NO entry can be quoted", async () => {
      stubWithSupported();
      const app = express();
      app.use(
        "/paid",
        paymentRequired({
          facilitator: new FacilitatorClient("https://f.example", { apiKey: "k" }),
          requirements: {
            payTo: "merchant::x",
            resource: "https://f.example/paid",
            accepts: [{ amount: "1", asset: "GBPx" }],
          },
        }),
      );
      app.get("/paid", (_q, r) => r.json({ ok: true }));
      const res = await request(app).get("/paid");
      expect(res.status).toBe(500);
      expect(res.body.details).toContain("GBPx");
    });

    it("answers 502 for an outage, however many ways to pay there are", async () => {
      // The facilitator being down is one cause with several witnesses. Before
      // this, two entries wrapped their two FacilitatorErrors in a plain Error
      // and answered 500 — our fault, nothing to retry — for exactly the
      // outage a one-entry route answered 502 for.
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("down", { status: 503 })),
      );
      const outage = async (assets: string[]) => {
        const app = express();
        app.use(
          "/paid",
          paymentRequired({
            facilitator: new FacilitatorClient("https://f.example", { apiKey: "k" }),
            requirements: {
              payTo: "merchant::x",
              resource: "https://f.example/paid",
              accepts: assets.map((asset, i) => ({ amount: `${i + 1}0`, asset })),
            },
          }),
        );
        return request(app).get("/paid");
      };
      const one = await outage(["Amulet"]);
      const two = await outage(["Amulet", "USDCx"]);
      expect(two.status).toBe(one.status);
      expect(two.status).toBe(502);
      expect(two.body.error).toBe("facilitator_error");
    });

    it("still reports several unrelated failures together", async () => {
      // The rethrow above is for a cause that is the facilitator's. These two
      // are the merchant's, so they stay an aggregate: two things to fix, each
      // named with the entry it came from.
      stubWithSupported();
      const app = express();
      app.use(
        "/paid",
        paymentRequired({
          facilitator: new FacilitatorClient("https://f.example", { apiKey: "k" }),
          requirements: {
            payTo: "merchant::x",
            resource: "https://f.example/paid",
            network: "canton:devnet",
            accepts: [
              { amount: "1", asset: "GBPx" },
              { amount: "2", asset: "JPYx" },
            ],
          },
        }),
      );
      const res = await request(app).get("/paid");
      expect(res.status).toBe(500);
      expect(res.body.details).toMatch(/1: .*GBPx/);
      expect(res.body.details).toMatch(/2: .*JPYx/);
    });

    it("never skips a merchant's own mistake", async () => {
      // A decimal price is config, not the facilitator changing under us, so
      // it takes the request down rather than quietly dropping the entry. Both
      // instruments are advertised, so the entry resolves and only its amount
      // is wrong.
      stubWithSupported({
        kinds: [
          {
            ...SUPPORTED.kinds[0],
            extra: {
              ...SUPPORTED.kinds[0].extra,
              instruments: [
                { admin: DSO, instrumentId: { id: "Amulet", admin: DSO }, symbol: "CC" },
                { admin: "ISSUER::x", instrumentId: { id: "USDCx", admin: "ISSUER::x" }, symbol: "USDCx" },
              ],
            },
          },
        ],
      });
      const app = express();
      app.use(
        "/paid",
        paymentRequired({
          facilitator: new FacilitatorClient("https://f.example", { apiKey: "k" }),
          requirements: {
            payTo: "merchant::x",
            resource: "https://f.example/paid",
            accepts: [
              { amount: "500000000", asset: "Amulet" },
              { amount: "0.10", asset: { instrumentId: { id: "USDCx", admin: "ISSUER::x" } } },
            ],
          },
        }),
      );
      app.get("/paid", (_q, r) => r.json({ ok: true }));
      const res = await request(app).get("/paid");
      expect(res.status).toBe(500);
      expect(res.body.details).toMatch(/atomic units/);
    });
  });


  it("keeps a shared term when an entry holds an explicit undefined", async () => {
    // `payTo: someVar` where someVar is undefined used to erase the shared
    // payee, and exactOptionalPropertyTypes is off so nothing caught it.
    stubFacilitator();
    const app = express();
    const absent = undefined as string | undefined;
    app.use(
      "/paid",
      paymentRequired({
        ...baseOptions,
        requirements: {
          network: "canton:x",
          payTo: "merchant::shared",
          resource: "https://f.example/paid",
          accepts: [
            {
              amount: "500000000",
              asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } },
              payTo: absent,
            },
          ],
        },
      }),
    );
    app.get("/paid", (_q, r) => r.json({ ok: true }));
    const res = await request(app).get("/paid");
    expect(res.status).toBe(402);
    expect(res.body.accepts[0].payTo).toBe("merchant::shared");
  });


  it("books ONE order for a challenge, however many ways it offers to pay", async () => {
    // The generator only gets `req`, so it cannot tell entries apart. Minting
    // per entry would book N orders and be paid for one.
    stubFacilitator();
    const booked: string[] = [];
    let n = 0;
    // The merchant's one generator, given to both entries — `memo` is a
    // per-entry field, so this is how one is shared.
    const bookOrder = () => {
      const ref = `order-${++n}`;
      booked.push(ref);
      return ref;
    };
    const app = express();
    app.use(
      "/paid",
      paymentRequired({
        ...baseOptions,
        requirements: {
          network: "canton:x",
          payTo: "merchant::x",
          resource: "https://f.example/paid",
          accepts: [
            {
              amount: "500000000",
              asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } },
              memo: bookOrder,
            },
            {
              amount: "250000",
              asset: { instrumentId: { id: "USDCx", admin: "ISSUER::x" } },
              memo: bookOrder,
            },
          ],
        },
      }),
    );
    app.get("/paid", (_q, r) => r.json({ ok: true }));
    const res = await request(app).get("/paid");
    expect(res.status).toBe(402);
    expect(booked).toEqual(["order-1"]);
    // And both ways to pay carry it, so whichever the payer picks reconciles.
    expect(res.body.accepts.map((a: { extra: { memo: string } }) => a.extra.memo)).toEqual([
      "order-1",
      "order-1",
    ]);
  });

  it("gives entries their own reference when they name their own generator", async () => {
    // Different generators is the merchant asking for different references.
    stubFacilitator();
    const app = express();
    app.use(
      "/paid",
      paymentRequired({
        ...baseOptions,
        requirements: {
          network: "canton:x",
          payTo: "merchant::x",
          resource: "https://f.example/paid",
          accepts: [
            {
              amount: "500000000",
              asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } },
              memo: () => "cc-order",
            },
            {
              amount: "250000",
              asset: { instrumentId: { id: "USDCx", admin: "ISSUER::x" } },
              memo: () => "usdc-order",
            },
          ],
        },
      }),
    );
    app.get("/paid", (_q, r) => r.json({ ok: true }));
    const res = await request(app).get("/paid");
    expect(res.body.accepts.map((a: { extra: { memo: string } }) => a.extra.memo)).toEqual([
      "cc-order",
      "usdc-order",
    ]);
  });


  it("refuses a builder whose ways to pay name different resources", async () => {
    // Entries cannot override `resource`, but a builder returns finished
    // requirements — and the envelope takes one resource, so it would silently
    // be the first.
    stubFacilitator();
    const built = {
      scheme: "exact",
      network: "canton:x",
      amount: "500000000",
      asset: "CC",
      payTo: "merchant::x",
      maxTimeoutSeconds: 60,
      extra: {
        assetTransferMethod: "transfer-factory",
        executeBeforeSeconds: 120,
        instrumentId: { id: "Amulet", admin: "DSO::x" },
      },
    } as CantonPaymentRequirements;
    const app = express();
    app.use(
      "/paid",
      paymentRequired({
        ...baseOptions,
        requirements: () => [
          { ...built, resource: "https://merchant.example/report" },
          { ...built, amount: "250000", resource: "https://merchant.example/other" },
        ],
      }),
    );
    app.get("/paid", (_q, r) => r.json({ ok: true }));
    const res = await request(app).get("/paid");
    expect(res.status).toBe(500);
    expect(res.body.details).toMatch(/A 402 names one/);
  });

  it("takes a builder whose ways to pay agree on the resource", async () => {
    stubFacilitator();
    const built = {
      scheme: "exact",
      network: "canton:x",
      amount: "500000000",
      asset: "CC",
      payTo: "merchant::x",
      resource: "https://merchant.example/report",
      maxTimeoutSeconds: 60,
      extra: {
        assetTransferMethod: "transfer-factory",
        executeBeforeSeconds: 120,
        instrumentId: { id: "Amulet", admin: "DSO::x" },
      },
    } as CantonPaymentRequirements;
    const app = express();
    app.use(
      "/paid",
      paymentRequired({
        ...baseOptions,
        requirements: () => [built, { ...built, amount: "250000", asset: "USDCx" }],
      }),
    );
    app.get("/paid", (_q, r) => r.json({ ok: true }));
    const res = await request(app).get("/paid");
    expect(res.status).toBe(402);
    expect(res.body.resource.url).toBe("https://merchant.example/report");
  });

});
