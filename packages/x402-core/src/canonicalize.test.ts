import { describe, it, expect } from "vitest";
import { canonicalJson, requirementsHash, canonicalSha256Hex } from "./index";
import type { CantonPaymentRequirements } from "./index";

// Golden vector generated from the FACILITATOR's actual canonicalize.ts
// (src/facilitator/canonicalize.ts) on this exact fixture. If either side's
// canonicalization drifts, requirementsHash diverges and every /v2/verify fails —
// so this test pins byte-for-byte parity. Regenerate ONLY if the facilitator's
// algorithm intentionally changes (and update the facilitator in lockstep).
const REQUIREMENTS: CantonPaymentRequirements = {
  scheme: "exact-canton",
  network: "canton:1220be58c29e",
  maxAmountRequired: "0.01",
  asset: { instrumentId: { id: "Amulet", admin: "DSO::1220be58c29e" } },
  payTo: "merchant::1220dead",
  resource: "/api/resource",
  nonce: "550e8400-e29b-41d4-a716-446655440000",
  validBefore: "2026-01-01T00:00:00.000Z",
};

const GOLDEN_CANONICAL =
  '{"asset":{"instrumentId":{"admin":"DSO::1220be58c29e","id":"Amulet"}},' +
  '"maxAmountRequired":"0.01","network":"canton:1220be58c29e",' +
  '"nonce":"550e8400-e29b-41d4-a716-446655440000","payTo":"merchant::1220dead",' +
  '"resource":"/api/resource","scheme":"exact-canton",' +
  '"validBefore":"2026-01-01T00:00:00.000Z"}';

const GOLDEN_HASH = "bdae45a239db3b771ee0ee5f70b4310f6b8894245666a3c7718b0a14674e0529";

describe("requirements hashing — facilitator parity", () => {
  it("canonicalizes to the golden string (keys sorted, nested sorted)", () => {
    expect(canonicalJson(REQUIREMENTS)).toBe(GOLDEN_CANONICAL);
  });

  it("hashes to the golden hex (byte-for-byte parity with the facilitator)", () => {
    expect(requirementsHash(REQUIREMENTS)).toBe(GOLDEN_HASH);
    expect(canonicalSha256Hex(REQUIREMENTS)).toBe(GOLDEN_HASH);
  });

  it("is order-independent (field order in the object doesn't change the hash)", () => {
    const reordered: CantonPaymentRequirements = {
      validBefore: REQUIREMENTS.validBefore,
      scheme: REQUIREMENTS.scheme,
      resource: REQUIREMENTS.resource,
      payTo: REQUIREMENTS.payTo,
      nonce: REQUIREMENTS.nonce,
      asset: REQUIREMENTS.asset,
      network: REQUIREMENTS.network,
      maxAmountRequired: REQUIREMENTS.maxAmountRequired,
    };
    expect(requirementsHash(reordered)).toBe(GOLDEN_HASH);
  });
});

describe("canonicalJson — RFC 8785 rules", () => {
  it("sorts object keys lexicographically", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("drops undefined members", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("serializes numbers in shortest round-trip form", () => {
    expect(canonicalJson({ n: 1.0, m: 100 })).toBe('{"m":100,"n":1}');
  });

  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("throws on non-finite numbers", () => {
    expect(() => canonicalJson({ x: Infinity })).toThrow();
  });
});
