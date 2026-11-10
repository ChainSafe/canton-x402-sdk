import { describe, it, expect } from "vitest";
import {
  encodePaymentHeader,
  decodePaymentHeader,
  encodePaymentRequiredHeader,
  decodePaymentRequiredHeader,
  MAX_PAYMENT_DEPTH,
} from "./payment-header";
import { isCantonPaymentRequiredResponse } from "./index";
import type { CantonPaymentPayload, CantonPaymentRequirements, CantonPaymentRequiredResponse } from "./index";

const requirements: CantonPaymentRequirements = {
  scheme: "exact",
  network: "canton:devnet",
  amount: "500000000",
  asset: "CC",
  extra: { assetTransferMethod: "transfer-factory", executeBeforeSeconds: 120, instrumentId: { id: "Amulet", admin: "DSO::1220x" } },
  payTo: "merchant::1220x",
  maxTimeoutSeconds: 60,
};

const payload: CantonPaymentPayload = {
  x402Version: 2,
  accepted: requirements,
  payload: {
    assetTransferMethod: "transfer-factory",
    preparedTransaction: "b",
    preparedTxHash: "h",
    signature: "s",
    publicKey: "pk",
    hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
  },
};

describe("PAYMENT-SIGNATURE codec", () => {
  it("round-trips the payment, with the requirements it was built against as `accepted`", () => {
    const decoded = decodePaymentHeader(encodePaymentHeader(payload));
    expect(decoded).toEqual(payload);
    expect(decoded.accepted).toEqual(requirements);
  });

  it("serialises the bare x402 v2 payment, with no wrapper around it", () => {
    const obj = JSON.parse(atob(encodePaymentHeader(payload)));
    expect(Object.keys(obj).sort()).toEqual(["accepted", "payload", "x402Version"]);
    expect(obj).toEqual(payload);
  });

  it("carries resource and extensions through, including an explicit null", () => {
    const withExtras: CantonPaymentPayload = {
      ...payload,
      resource: { url: "https://merchant.example/r", description: "A report", mimeType: null },
      extensions: { "x-example": { info: { a: 1 }, schema: {} } },
    };
    expect(decodePaymentHeader(encodePaymentHeader(withExtras))).toEqual(withExtras);
    const nulls = { ...payload, resource: null, extensions: null };
    expect(decodePaymentHeader(encodePaymentHeader(nulls))).toEqual(nulls);
  });

  it("decodes any scheme's payment — concrete inner validation is the verifier's job", () => {
    // Decode validates the envelope (x402 v2, an accepted with the fields every
    // scheme's requirements share, a payload object), NOT the canton-exact inner
    // or accepted's extra. Another scheme's payment must decode; the per-scheme
    // verifier rejects it downstream.
    const foreign = {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "eip155:84532",
        amount: "10000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0xC0ffee",
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
      },
      payload: { signature: "0xfeed", authorization: { from: "0xA" } },
    };
    expect(decodePaymentHeader(btoa(JSON.stringify(foreign)))).toEqual(foreign);
  });

  it("refuses the pre-spec envelopes: the { payment, requirements } wrapper, and top-level scheme/network", () => {
    const { accepted: _omit, ...inner } = payload;
    const legacyPayment = { ...inner, scheme: "exact", network: "canton:devnet" };
    for (const legacy of [{ payment: legacyPayment, requirements }, legacyPayment]) {
      expect(() => decodePaymentHeader(btoa(JSON.stringify(legacy)))).toThrow(/not an x402 v2 payment/);
    }
  });

  it("refuses an accepted that is missing, null, an array, a string, or not a whole PaymentRequirements", () => {
    const { accepted, ...inner } = payload;
    // Each field the spec requires of every scheme's PaymentRequirements.
    const required = ["scheme", "network", "amount", "asset", "payTo", "maxTimeoutSeconds"] as const;
    const bad = [
      inner,
      { ...inner, accepted: null },
      { ...inner, accepted: [] },
      { ...inner, accepted: "exact" },
      { ...inner, accepted: { scheme: "exact", network: "canton:devnet" } },
      { ...inner, accepted: { ...accepted, scheme: "" } },
      ...required.map((key) => ({ ...inner, accepted: { ...accepted, [key]: undefined } })),
    ];
    for (const value of bad) {
      expect(() => decodePaymentHeader(btoa(JSON.stringify(value)))).toThrow(/not an x402 v2 payment/);
    }
  });

  it("refuses another x402Version, and a resource without a url", () => {
    expect(() => decodePaymentHeader(btoa(JSON.stringify({ ...payload, x402Version: 1 })))).toThrow(
      /not an x402 v2 payment/,
    );
    expect(() =>
      decodePaymentHeader(btoa(JSON.stringify({ ...payload, resource: { description: "no url" } }))),
    ).toThrow(/not an x402 v2 payment/);
  });

  it("handles non-ASCII content (isomorphic UTF-8)", () => {
    const p: CantonPaymentPayload = { ...payload, accepted: { ...requirements, description: "Café crème ☕" } };
    expect(decodePaymentHeader(encodePaymentHeader(p))).toEqual(p);
  });

  it("refuses a payment nested deeper than MAX_PAYMENT_DEPTH, and takes one at the cap", () => {
    // Built as text: JSON.stringify itself overflows on the deepest case, which
    // is the failure the cap keeps away from the facilitator call. The payment
    // is 2 levels deep where extensions.x starts.
    const withNested = (levels: number): string =>
      JSON.stringify(payload).slice(0, -1) + `,"extensions":{"x":${"[".repeat(levels)}0${"]".repeat(levels)}}}`;
    expect(decodePaymentHeader(btoa(withNested(MAX_PAYMENT_DEPTH - 2))).extensions).toBeDefined();
    for (const levels of [MAX_PAYMENT_DEPTH - 1, 5000]) {
      expect(() => decodePaymentHeader(btoa(withNested(levels)))).toThrow(/nests deeper than/);
    }
  });

  it("throws on invalid base64 and invalid JSON", () => {
    expect(() => decodePaymentHeader("not-base64!!")).toThrow(/not valid base64/);
    expect(() => decodePaymentHeader(btoa("not json at all"))).toThrow(/not valid JSON/);
  });

  it("throws when the decoded value is not an object", () => {
    for (const value of [42, null, "x", []]) {
      expect(() => decodePaymentHeader(btoa(JSON.stringify(value)))).toThrow(/not an x402 v2 payment/);
    }
  });
});

describe("PAYMENT-REQUIRED codec", () => {
  /** What a client does with the header: base64 → UTF-8 → JSON. */
  const read = (header: string): unknown =>
    JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(header), (c) => c.charCodeAt(0))));

  const paymentRequired: CantonPaymentRequiredResponse = {
    x402Version: 2,
    resource: { url: "https://merchant.example/r", description: "A report" },
    accepts: [requirements],
    error: "payment_required",
  };

  it("serialises the PaymentRequired as base64 JSON, nothing around it", () => {
    const header = encodePaymentRequiredHeader(paymentRequired);
    expect(header).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(read(header)).toEqual(paymentRequired);
    expect(isCantonPaymentRequiredResponse(read(header))).toBe(true);
  });

  it("encodes non-ASCII as UTF-8", () => {
    const p = { ...paymentRequired, resource: { url: "https://merchant.example/r", description: "Café crème ☕" } };
    expect(read(encodePaymentRequiredHeader(p))).toEqual(p);
  });
});

describe("decodePaymentRequiredHeader", () => {
  const offer = {
    x402Version: 2 as const,
    resource: { url: "https://merchant.example/r", description: "A report" },
    accepts: [requirements],
    error: "payment_required",
  };

  it("round-trips what encodePaymentRequiredHeader wrote", () => {
    expect(decodePaymentRequiredHeader(encodePaymentRequiredHeader(offer))).toEqual(offer);
  });

  it("refuses base64 that is not an x402 v2 PaymentRequired", () => {
    const b64 = (v: unknown) => btoa(JSON.stringify(v));
    for (const bad of [
      { x402Version: 1, resource: offer.resource, accepts: [requirements] },
      { x402Version: 2, accepts: [requirements] },
      { x402Version: 2, resource: { description: "no url" }, accepts: [requirements] },
      { x402Version: 2, resource: offer.resource },
      // The payment envelope, not the offer — a reader must not confuse them.
      { x402Version: 2, accepted: requirements, payload: {} },
    ]) {
      expect(() => decodePaymentRequiredHeader(b64(bad))).toThrow(/not an x402 v2 PaymentRequired/);
    }
  });

  it("refuses bad base64 and bad JSON, naming which", () => {
    expect(() => decodePaymentRequiredHeader("!!!")).toThrow(/not valid base64|not valid JSON/);
    expect(() => decodePaymentRequiredHeader(btoa("{nope"))).toThrow(/not valid JSON/);
  });

  it("refuses one nested deeper than MAX_PAYMENT_DEPTH", () => {
    let deep: unknown = "x";
    for (let i = 0; i < MAX_PAYMENT_DEPTH + 2; i++) deep = { deep };
    const bad = btoa(JSON.stringify({ ...offer, extensions: deep }));
    expect(() => decodePaymentRequiredHeader(bad)).toThrow(/nests deeper than/);
  });
});
