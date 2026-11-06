import { describe, it, expect } from "vitest";
import { encodePaymentHeader, decodePaymentHeader, MAX_PAYMENT_DEPTH } from "./payment-header";
import type { CantonPaymentPayload, CantonPaymentRequirements } from "./index";

const requirements: CantonPaymentRequirements = {
  scheme: "exact",
  network: "canton:devnet",
  amount: "500000000",
  asset: "CC",
  extra: { assetTransferMethod: "transfer-factory", instrumentId: { id: "Amulet", admin: "DSO::1220x" } },
  payTo: "merchant::1220x",
  resource: "/r",
  nonce: "n",
  validBefore: "2999-01-01T00:00:00.000Z",
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

describe("X-PAYMENT codec", () => {
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
    // Decode validates the envelope (x402 v2, an accepted with a scheme and a
    // network, a payload object), NOT the canton-exact inner or the full
    // requirements. Another scheme's payment must decode; the per-scheme
    // verifier rejects it downstream.
    const foreign = {
      x402Version: 2,
      accepted: { scheme: "exact", network: "eip155:84532", amount: "10000", payTo: "0xC0ffee" },
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

  it("refuses an accepted that is missing, null, an array, a string, or has no scheme or network", () => {
    const { accepted: _omit, ...inner } = payload;
    const bad = [
      inner,
      { ...inner, accepted: null },
      { ...inner, accepted: [] },
      { ...inner, accepted: "exact" },
      { ...inner, accepted: { network: "canton:devnet" } },
      { ...inner, accepted: { scheme: "exact" } },
      { ...inner, accepted: { scheme: "", network: "canton:devnet" } },
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
