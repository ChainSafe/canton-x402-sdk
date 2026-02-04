import { describe, it, expect } from "vitest";
import { verify } from "../canton/verify.js";
import type { PaymentPayload, PaymentRequirements } from "../types.js";

const PAYER = "alice::12201234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const PAYEE = "bob::1220abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const RESOURCE = "https://example.com/api/resource";

function makePayload(overrides?: Partial<PaymentPayload>): PaymentPayload {
  return {
    x402Version: 1,
    scheme: "exact-canton",
    network: "canton-local",
    payload: {
      command: {
        payer: PAYER,
        payee: PAYEE,
        amount: "1.00",
        currency: "CC",
        resourceId: RESOURCE,
        nonce: "test-nonce-1",
      },
    },
    ...overrides,
  };
}

function makeRequirements(
  overrides?: Partial<PaymentRequirements>,
): PaymentRequirements {
  return {
    scheme: "exact-canton",
    network: "canton-local",
    maxAmountRequired: "1.00",
    resource: RESOURCE,
    payTo: PAYEE,
    asset: "CC",
    ...overrides,
  };
}

describe("verify", () => {
  it("accepts a valid payment", async () => {
    const result = await verify(makePayload(), makeRequirements());
    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(PAYER);
  });

  it("rejects unsupported scheme", async () => {
    const result = await verify(
      makePayload({ scheme: "exact" }),
      makeRequirements(),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("unsupported_scheme");
  });

  it("rejects network mismatch", async () => {
    const result = await verify(
      makePayload({ network: "canton-mainnet" }),
      makeRequirements(),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("network_mismatch");
  });

  it("rejects payee mismatch", async () => {
    const result = await verify(
      makePayload(),
      makeRequirements({ payTo: "other::1220aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("payee_mismatch");
  });

  it("rejects insufficient amount", async () => {
    const payload = makePayload();
    payload.payload.command.amount = "0.50";
    const result = await verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("insufficient_amount");
  });

  it("rejects invalid amount format", async () => {
    const payload = makePayload();
    payload.payload.command.amount = "not-a-number";
    const result = await verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_amount_format");
  });

  it("rejects expired payment", async () => {
    const payload = makePayload();
    payload.payload.command.expiresAt = new Date(
      Date.now() - 60000,
    ).toISOString();
    const result = await verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("payment_expired");
  });

  it("accepts non-expired payment", async () => {
    const payload = makePayload();
    payload.payload.command.expiresAt = new Date(
      Date.now() + 3600000,
    ).toISOString();
    const result = await verify(payload, makeRequirements());
    expect(result.isValid).toBe(true);
  });

  it("rejects empty nonce (caught as missing required field)", async () => {
    const payload = makePayload();
    payload.payload.command.nonce = "";
    const result = await verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("missing_required_fields");
  });

  it("rejects whitespace-only nonce", async () => {
    const payload = makePayload();
    payload.payload.command.nonce = "   ";
    const result = await verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("missing_or_empty_nonce");
  });

  it("rejects currency mismatch", async () => {
    const payload = makePayload();
    payload.payload.command.currency = "USD";
    const result = await verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("currency_mismatch");
  });

  it("rejects invalid payer format", async () => {
    const payload = makePayload();
    payload.payload.command.payer = "invalid-party-id";
    const result = await verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_payer_format");
  });

  it("rejects resource mismatch", async () => {
    const payload = makePayload();
    payload.payload.command.resourceId = "https://other.com/resource";
    const result = await verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("resource_mismatch");
  });
});
