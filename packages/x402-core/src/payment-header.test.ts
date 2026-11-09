import { describe, it, expect } from "vitest";
import { encodePaymentHeader, decodePaymentHeader } from "./payment-header";
import type { CantonPaymentPayload, CantonPaymentRequirements } from "./index";

const payload: CantonPaymentPayload = {
  x402Version: 2,
  scheme: "exact",
  network: "canton:devnet",
  payload: {
    assetTransferMethod: "transfer-factory",
    payer: "alice::1220x",
    preparedTransaction: "b",
    preparedTxHash: "h",
    signature: "s",
    publicKey: "pk",
    hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
  },
};

const requirements: CantonPaymentRequirements = {
  scheme: "exact",
  network: "canton:devnet",
  amount: "500000000",
  asset: "CC",
  extra: { assetTransferMethod: "transfer-factory", executeBeforeSeconds: 120, instrumentId: { id: "Amulet", admin: "DSO::1220x" } },
  payTo: "merchant::1220x",
  resource: "/r",
  maxTimeoutSeconds: 60,
};

describe("X-PAYMENT codec", () => {
  it("round-trips { payment, requirements }", () => {
    const decoded = decodePaymentHeader(encodePaymentHeader(payload, requirements));
    expect(decoded.payload).toEqual(payload);
    expect(decoded.requirements).toEqual(requirements);
  });

  it("decodes any scheme's envelope — concrete inner validation is the verifier's job", () => {
    // Option A: decode validates the envelope (x402 shape + universal requirements),
    // NOT the canton-exact inner. A well-formed envelope carrying another scheme's
    // inner must decode; the per-scheme verifier rejects it downstream.
    const foreign = {
      payment: {
        x402Version: 2,
        scheme: "batch-settlement-canton",
        network: "eip155:1",
        payload: { evmTxHash: "0xfeed", quoteId: "q-1" },
      },
      requirements: {
        scheme: "batch-settlement-canton",
        network: "eip155:1",
        amount: "1000000",
        payTo: "0xC0ffee",
        maxTimeoutSeconds: 60,
        asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      },
    };
    const decoded = decodePaymentHeader(btoa(JSON.stringify(foreign)));
    expect(decoded.payload).toEqual(foreign.payment);
    expect(decoded.requirements).toEqual(foreign.requirements);
  });

  it("serialises two separate slots — no merge, no paymentRequirements", () => {
    const obj = JSON.parse(atob(encodePaymentHeader(payload, requirements)));
    expect(Object.keys(obj).sort()).toEqual(["payment", "requirements"]);
    expect(obj.payment).toEqual(payload);
    expect("paymentRequirements" in obj).toBe(false);
    // requirements do not leak into the payment slot
    expect("requirements" in obj.payment).toBe(false);
  });

  it("throws a slot-specific error when `payment` is missing or malformed", () => {
    expect(() => decodePaymentHeader(btoa(JSON.stringify({ requirements })))).toThrow(
      /`payment` slot/,
    );
    expect(() =>
      decodePaymentHeader(btoa(JSON.stringify({ payment: { x402Version: 2 }, requirements }))),
    ).toThrow(/`payment` slot/);
  });

  it("throws a slot-specific error when `requirements` is missing or malformed", () => {
    expect(() => decodePaymentHeader(btoa(JSON.stringify({ payment: payload })))).toThrow(
      /`requirements` slot/,
    );
    expect(() =>
      decodePaymentHeader(
        btoa(JSON.stringify({ payment: payload, requirements: { scheme: "exact" } })),
      ),
    ).toThrow(/`requirements` slot/);
  });

  it("handles non-ASCII content (isomorphic UTF-8)", () => {
    const p: CantonPaymentPayload = {
      ...payload,
      payload: { ...payload.payload, payer: "café::1220x" },
    };
    const decoded = decodePaymentHeader(encodePaymentHeader(p, requirements));
    expect(decoded.payload).toEqual(p);
  });

  it("throws on invalid base64 and invalid JSON", () => {
    expect(() => decodePaymentHeader("not-base64!!")).toThrow(/not valid base64/);
    expect(() => decodePaymentHeader(btoa("not json at all"))).toThrow(/not valid JSON/);
  });

  it("throws when the decoded value is not a { payment, requirements } object", () => {
    expect(() => decodePaymentHeader(btoa(JSON.stringify(42)))).toThrow(
      /did not decode to a .* envelope/,
    );
  });
});
