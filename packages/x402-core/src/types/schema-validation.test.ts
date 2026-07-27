import { describe, it, expect } from "vitest";
import { ValiError } from "valibot";
import {
  isCantonPaymentInner,
  parseCantonPaymentInner,
  isCantonPaymentRequirements,
  parseCantonPaymentRequirements,
  isCantonVerifyRequest,
  isX402Request,
} from "../index";
import type { CantonPaymentInner } from "./payment";
import type { CantonPaymentRequirements } from "./requirements";

const inner: CantonPaymentInner = {
  payer: "alice::1220beef",
  preparedTransaction: "cHJlcGFyZWQ=",
  preparedTransactionHash: "deadbeef",
  partySignature: "cafe",
  requirementsHash: "0f1e2d",
  publicKey: "cHVibGljS2V5",
  hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
};

const requirements: CantonPaymentRequirements = {
  scheme: "exact-canton",
  network: "canton:1220be58c29e",
  maxAmountRequired: "0.01",
  asset: { instrumentId: { id: "Amulet", admin: "DSO::1220be58c29e" } },
  payTo: "merchant::1220dead",
  resource: "/api/resource",
  nonce: "550e8400-e29b-41d4-a716-446655440000",
  validBefore: "2999-01-01T00:00:00.000Z",
};

describe("schema-first guards + parsers", () => {
  it("accepts a well-formed inner / requirements", () => {
    expect(isCantonPaymentInner(inner)).toBe(true);
    expect(parseCantonPaymentInner(inner)).toEqual(inner);
    expect(isCantonPaymentRequirements(requirements)).toBe(true);
    expect(parseCantonPaymentRequirements(requirements)).toEqual(requirements);
  });

  it("checks EVERY field — a missing one fails (no partial-guard drift)", () => {
    // The historical bug: a guard that validated a subset. Drop each required
    // field in turn; the schema must reject all of them.
    for (const key of Object.keys(inner) as (keyof CantonPaymentInner)[]) {
      const { [key]: _omitted, ...partial } = inner;
      expect(isCantonPaymentInner(partial)).toBe(false);
    }
    expect(isCantonPaymentRequirements({ ...requirements, asset: undefined })).toBe(false);
  });

  it("parse throws a structured error naming the failing field", () => {
    const { publicKey: _omit, ...noPublicKey } = inner;
    expect(() => parseCantonPaymentInner(noPublicKey)).toThrow(ValiError);
    try {
      parseCantonPaymentInner(noPublicKey);
    } catch (err) {
      const issues = (err as ValiError<typeof import("../types/payment").CantonPaymentInnerSchema>).issues;
      const path = issues[0]?.path?.map((p) => p.key).join(".");
      expect(path).toBe("publicKey");
    }
  });

  it("rejects wrong field types", () => {
    expect(isCantonPaymentInner({ ...inner, payer: 42 })).toBe(false);
    expect(isCantonPaymentRequirements({ ...requirements, asset: { instrumentId: { id: "Amulet" } } })).toBe(false);
  });
});

describe("generic (loose) vs concrete (exact-canton) verify request", () => {
  const cantonReq = {
    x402Version: 2,
    paymentPayload: { x402Version: 2, scheme: "exact-canton", network: requirements.network, payload: inner },
    paymentRequirements: requirements,
  };
  // A different scheme: valid universal envelope, but the inner is NOT a CantonPaymentInner.
  const bridgeReq = {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      scheme: "batch-settlement-canton",
      network: "eip155:1",
      payload: { evmTxHash: "0xfeed", quoteId: "q-1" },
    },
    paymentRequirements: {
      scheme: "batch-settlement-canton",
      network: "eip155:1",
      maxAmountRequired: "1000000",
      payTo: "0xC0ffee",
      nonce: "n-bridge",
      validBefore: "2999-01-01T00:00:00.000Z",
      asset: { chainId: 1 },
    },
  };

  it("isX402Request accepts any scheme's envelope (scheme-agnostic dispatch gate)", () => {
    expect(isX402Request(cantonReq)).toBe(true);
    expect(isX402Request(bridgeReq)).toBe(true);
  });

  it("isCantonVerifyRequest accepts exact-canton but rejects another scheme's inner", () => {
    expect(isCantonVerifyRequest(cantonReq)).toBe(true);
    expect(isCantonVerifyRequest(bridgeReq)).toBe(false);
  });

  it("isX402Request rejects a malformed envelope", () => {
    expect(isX402Request({ x402Version: 2, paymentPayload: {}, paymentRequirements: {} })).toBe(false);
    expect(isX402Request({ x402Version: 2 })).toBe(false);
  });
});
