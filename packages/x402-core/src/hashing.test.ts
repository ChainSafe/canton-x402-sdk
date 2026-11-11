import { describe, it, expect } from "vitest";
// requirementsHash is the public entry; canonicalJson is a package-internal
// helper imported directly from the module (not re-exported by the barrel).
import { canonicalJson, requirementsHash } from "./hashing";
import type { CantonPaymentRequirements } from "./index";

// Golden vector generated from the FACILITATOR's actual canonicalize.ts
// (src/facilitator/canonicalize.ts) on this exact fixture. If either side's
// canonicalization drifts, the two compute different hashes for the same
// requirements — so this test pins byte-for-byte parity. Regenerate ONLY if the facilitator's
// algorithm intentionally changes (and update the facilitator in lockstep).
//
// Last regenerated when `resource` and `description` were dropped (#76). The hash covers every value in the object, so a new field
// moves it even though the algorithm is untouched. `maxTimeoutSeconds` is the
// first NUMBER in this vector, so it is also what pins number formatting
// across the two canonicalizers.
const REQUIREMENTS: CantonPaymentRequirements = {
  scheme: "exact",
  network: "canton:devnet",
  amount: "100000000",
  asset: "CC",
  extra: { assetTransferMethod: "transfer-factory", executeBeforeSeconds: 120, instrumentId: { id: "Amulet", admin: "DSO::1220be58c29e" } },
  payTo: "merchant::1220dead",
  maxTimeoutSeconds: 60,
};

const GOLDEN_CANONICAL =
  '{"amount":"100000000","asset":"CC",' +
  '"extra":{"assetTransferMethod":"transfer-factory","executeBeforeSeconds":120,' +
  '"instrumentId":{"admin":"DSO::1220be58c29e","id":"Amulet"}},' +
  '"maxTimeoutSeconds":60,"network":"canton:devnet",' +
  '"payTo":"merchant::1220dead","scheme":"exact"}';

const GOLDEN_HASH = "7ce2010798b65d3c3082b29a8e1071a96191457a844cac4330aa662f4ca9fb54";

describe("requirements hashing — facilitator parity", () => {
  it("canonicalizes to the golden string (keys sorted, nested sorted)", () => {
    expect(canonicalJson(REQUIREMENTS)).toBe(GOLDEN_CANONICAL);
  });

  it("hashes to the golden hex (byte-for-byte parity with the facilitator)", () => {
    expect(requirementsHash(REQUIREMENTS)).toBe(GOLDEN_HASH);
  });

  it("is order-independent (field order in the object doesn't change the hash)", () => {
    const reordered: CantonPaymentRequirements = {
      extra: REQUIREMENTS.extra,
      scheme: REQUIREMENTS.scheme,
      payTo: REQUIREMENTS.payTo,
      asset: REQUIREMENTS.asset,
      network: REQUIREMENTS.network,
      amount: REQUIREMENTS.amount,
      maxTimeoutSeconds: REQUIREMENTS.maxTimeoutSeconds,
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
