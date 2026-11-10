// The middleware with a scheme that is not Canton's.
//
// The point of the adapter seam is that nothing in the flow is canton-shaped.
// A made-up scheme is the only thing that proves it: if any canton assumption
// were left in the middleware — the shape of `extra`, the guard, where a
// reference lives — these tests would fail and the canton ones would not.

import { describe, it, expect, vi, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import {
  encodePaymentHeader,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from "@chainsafe/x402-core";
import { FacilitatorClient } from "@chainsafe/x402-client";

import { paymentRequired } from "./middleware.js";
import type { BaseRequirementsSpec, SchemeAdapter, SchemeQuote } from "./scheme.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/* ------------------------------------------------------------------ *
 * A scheme with nothing canton about it
 * ------------------------------------------------------------------ */

interface VoucherExtra {
  /** Which voucher book the code must come from. */
  book: string;
  /** Per-challenge reference, under a different key than canton's `memo`. */
  ticket?: string;
  [key: string]: unknown;
}

type VoucherRequirements = X402PaymentRequirements<VoucherExtra>;
type VoucherPayload = X402PaymentPayload<{ code: string }>;

interface VoucherSpec extends BaseRequirementsSpec {
  book: string;
  issueTicket?: () => Promise<string>;
}

function voucherScheme(): SchemeAdapter<VoucherSpec, VoucherRequirements, VoucherPayload> {
  return {
    id: "voucher",
    acceptsRequirements(r): r is VoucherRequirements {
      const extra = (r as { extra?: unknown }).extra;
      return (
        typeof extra === "object" &&
        extra !== null &&
        typeof (extra as VoucherExtra).book === "string"
      );
    },
    acceptsPayload(p): p is VoucherPayload {
      return typeof (p.payload as { code?: unknown }).code === "string";
    },
    payerOf(p) {
      // This scheme names its payer outright; canton-exact has to decode a
      // signed transfer for the same answer. The middleware does not care.
      return p.payload.code.startsWith("VCH-") ? `holder-of-${p.payload.code}` : undefined;
    },
    extraRules: {
      book: { compare: "equal", reason: "policy_wrong_book" },
      ticket: { compare: "skip", why: "per-challenge" },
    },
    async quote(_req, spec): Promise<SchemeQuote> {
      const quote: SchemeQuote = {
        scheme: "voucher",
        network: "vouchers:test",
        asset: "VCH",
        extra: { book: spec.book },
      };
      const issue = spec.issueTicket;
      if (issue) quote.mintReference = async () => ({ ticket: await issue() });
      return quote;
    },
  };
}

function voucherHeader(
  over: Record<string, unknown> = {},
  extra?: Record<string, unknown>,
  envelope: Record<string, unknown> = {},
): string {
  const requirements = {
    scheme: "voucher",
    network: "vouchers:test",
    amount: "10",
    asset: "VCH",
    extra: extra ?? { book: "autumn-2026" },
    payTo: "shop::1",
    resource: "https://shop.example/paid",
    description: "Access",
    maxTimeoutSeconds: 60,
    ...over,
  } as unknown as VoucherRequirements;
  const payload = {
    x402Version: 2,
    scheme: "voucher",
    network: "vouchers:test",
    payload: { code: "VCH-123" },
    ...envelope,
  } as VoucherPayload;
  return encodePaymentHeader(payload as never, requirements as never);
}

function voucherApp(over: Record<string, unknown> = {}): Express {
  const app = express();
  app.use(
    "/paid",
    paymentRequired<VoucherSpec, VoucherRequirements, VoucherPayload>({
      facilitator: new FacilitatorClient("https://f.example", { apiKey: "k" }),
      scheme: voucherScheme(),
      requirements: {
        payTo: "shop::1",
        resource: "https://shop.example/paid",
        accepts: [
          {
            amount: "10",
            book: "autumn-2026",
            ...over,
          },
        ],
      },
    }),
  );
  app.get("/paid", (req, res) => res.json({ ok: true, payer: req.x402?.payer }));
  return app;
}

function stubFacilitator(over?: { verify?: unknown }) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes("/v2/verify"))
      return json(over?.verify ?? { isValid: true, payer: "buyer::1" });
    return new Response("no route", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("paymentRequired with a non-canton scheme", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("challenges with the scheme's own network, asset and extra", async () => {
    stubFacilitator();
    const res = await request(voucherApp()).get("/paid");
    expect(res.status).toBe(402);
    expect(res.body.accepts[0]).toMatchObject({
      scheme: "voucher",
      network: "vouchers:test",
      asset: "VCH",
      extra: { book: "autumn-2026" },
    });
    // No canton field was invented on the way through.
    expect(res.body.accepts[0].extra).not.toHaveProperty("assetTransferMethod");
    expect(res.body.accepts[0].extra).not.toHaveProperty("instrumentId");
  });

  it("verifies a payment against the scheme's own extra", async () => {
    const fetchMock = stubFacilitator();
    const res = await request(voucherApp()).get("/paid").set("X-PAYMENT", voucherHeader());
    expect(res.status).toBe(200);
    expect(res.body.payer).toBe("buyer::1");
    // The envelope the facilitator saw is the scheme's, unaltered.
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.paymentRequirements.extra).toEqual({ book: "autumn-2026" });
    expect(body.paymentPayload.payload).toEqual({ code: "VCH-123" });
  });

  it("applies the scheme's own extra rules", async () => {
    stubFacilitator();
    const res = await request(voucherApp())
      .get("/paid")
      .set("X-PAYMENT", voucherHeader({}, { book: "spring-2025" }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("policy_wrong_book");
  });

  it("still applies the protocol's common rules", async () => {
    // payTo/resource/amount are the middleware's, not the scheme's.
    stubFacilitator();
    const res = await request(voucherApp())
      .get("/paid")
      .set("X-PAYMENT", voucherHeader({ amount: "1" }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("policy_underpriced");
  });

  it("mints the scheme's reference once per challenge, under the scheme's own key", async () => {
    stubFacilitator();
    const issued: string[] = [];
    const app = voucherApp({
      issueTicket: async () => {
        const t = `ticket-${issued.length}`;
        issued.push(t);
        return t;
      },
    });

    const challenge = await request(app).get("/paid");
    expect(challenge.body.accepts[0].extra.ticket).toBe("ticket-0");
    expect(issued).toEqual(["ticket-0"]);

    const paid = await request(app)
      .get("/paid")
      .set("X-PAYMENT", voucherHeader({}, { book: "autumn-2026", ticket: "ticket-0" }));
    expect(paid.status).toBe(200);
    // Same discipline as canton's memo, with no canton code involved.
    expect(issued).toEqual(["ticket-0"]);
  });

  it("asks the scheme who paid when the facilitator does not say", async () => {
    // `payer` is optional in a verify response. The middleware must not know
    // how any scheme recovers it — canton decodes a transfer, this one reads a
    // field, and the flow is the same either way.
    stubFacilitator({ verify: { isValid: true } });
    const res = await request(voucherApp()).get("/paid").set("X-PAYMENT", voucherHeader());
    expect(res.status).toBe(200);
    expect(res.body.payer).toBe("holder-of-VCH-123");
  });

  it("refuses the payment when neither the facilitator nor the scheme can name a payer", async () => {
    const fetchMock = stubFacilitator({ verify: { isValid: true } });
    const res = await request(voucherApp())
      .get("/paid")
      .set("X-PAYMENT", voucherHeader({}, undefined, { payload: { code: "NOT-A-VOUCHER" } }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("transfer_mismatch");
    // Refused before settle, so nothing was captured for a request we then failed.
    for (const [url] of fetchMock.mock.calls) expect(String(url)).not.toContain("/v2/settle");
  });

  it("refuses a payload the scheme does not accept, without asking the facilitator", async () => {
    const fetchMock = stubFacilitator();
    const header = encodePaymentHeader(
      {
        x402Version: 2,
        scheme: "voucher",
        network: "vouchers:test",
        payload: { notACode: true },
      } as never,
      {
        scheme: "voucher",
        network: "vouchers:test",
        amount: "10",
        asset: "VCH",
        extra: { book: "autumn-2026" },
        payTo: "shop::1",
        resource: "https://shop.example/paid",
        maxTimeoutSeconds: 60,
      } as never,
    );
    const res = await request(voucherApp()).get("/paid").set("X-PAYMENT", header);
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("policy_payload_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses requirements the scheme does not accept", async () => {
    stubFacilitator();
    const res = await request(voucherApp())
      .get("/paid")
      .set("X-PAYMENT", voucherHeader({}, { noBook: 1 }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("policy_requirements_invalid");
  });
});
