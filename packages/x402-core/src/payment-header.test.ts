import { describe, it, expect } from "vitest";
import { encodePaymentHeader, decodePaymentHeader } from "./payment-header";
import type { CantonPaymentPayload, CantonPaymentRequirements } from "./index";

const payload = {
  x402Version: 2,
  scheme: "exact-canton",
  network: "canton:1220x",
  payload: {
    payer: "alice::1220x",
    preparedTransaction: "b",
    preparedTransactionHash: "h",
    partySignature: "s",
    requirementsHash: "rh",
  },
} as unknown as CantonPaymentPayload;

const requirements = {
  scheme: "exact-canton",
  network: "canton:1220x",
  maxAmountRequired: "0.05",
  asset: { instrumentId: { id: "Amulet", admin: "DSO::1220x" } },
  payTo: "merchant::1220x",
  resource: "/r",
  nonce: "n",
  validBefore: "2999-01-01T00:00:00.000Z",
} as CantonPaymentRequirements;

describe("X-PAYMENT codec", () => {
  it("round-trips a payload with echoed requirements", () => {
    const header = encodePaymentHeader(payload, requirements);
    const decoded = decodePaymentHeader(header);
    expect(decoded.payload).toEqual(payload);
    expect(decoded.requirements).toEqual(requirements);
  });

  it("does not leak paymentRequirements into the payload", () => {
    const decoded = decodePaymentHeader(encodePaymentHeader(payload, requirements));
    expect("paymentRequirements" in decoded.payload).toBe(false);
  });

  it("throws when the envelope is missing paymentRequirements", () => {
    const withoutRequirements = btoa(JSON.stringify(payload));
    expect(() => decodePaymentHeader(withoutRequirements)).toThrow(/missing paymentRequirements/);
  });

  it("handles non-ASCII content (isomorphic UTF-8)", () => {
    const p = { ...payload, payload: { ...payload.payload, payer: "café::1220x" } } as CantonPaymentPayload;
    const decoded = decodePaymentHeader(encodePaymentHeader(p, requirements));
    expect(decoded.payload).toEqual(p);
  });

  it("throws on invalid JSON", () => {
    const notJson = btoa("not json at all");
    expect(() => decodePaymentHeader(notJson)).toThrow(/not valid JSON/);
  });

  it("throws on a well-formed JSON that is not a payment envelope", () => {
    const wrong = btoa(JSON.stringify({ x402Version: 1, hello: "world" }));
    expect(() => decodePaymentHeader(wrong)).toThrow(/did not decode to a CantonPaymentPayload/);
  });
});
