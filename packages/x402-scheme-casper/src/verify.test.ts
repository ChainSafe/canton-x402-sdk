import { describe, it, expect } from "vitest";
import { createVerifierRegistry } from "@chainsafe/x402-core";
import {
  CASPER_MAINNET_NETWORK,
  CASPER_TESTNET_NETWORK,
  createExactCasperVerifier,
  isCasperNetworkId,
  isCasperPaymentInner,
  isCasperPaymentRequirements,
  parseCasperNetworkId,
  wcsprAsset,
} from "./index";
import type { CasperPaymentPayload, CasperPaymentRequirements } from "./index";

const WCSPR = "hash-" + "ab".repeat(32);
const NOW_SECONDS = Math.floor(Date.now() / 1000);

// A well-formed exact/casper payload + matching requirements on testnet.
function buildFixture() {
  const requirements: CasperPaymentRequirements = {
    scheme: "exact",
    network: CASPER_TESTNET_NETWORK,
    maxAmountRequired: "1000000000",
    asset: wcsprAsset(WCSPR),
    payTo: "account-hash-" + "cd".repeat(32),
    resource: "/api/resource",
    nonce: "550e8400-e29b-41d4-a716-446655440000",
    validBefore: "2999-01-01T00:00:00.000Z",
  };

  const payload: CasperPaymentPayload = {
    x402Version: 2,
    scheme: "exact",
    network: CASPER_TESTNET_NETWORK,
    payload: {
      signature: "ab".repeat(64),
      publicKey: "01" + "ef".repeat(32),
      authorization: {
        from: "account-hash-" + "12".repeat(32),
        to: requirements.payTo,
        value: "1000000000",
        validAfter: "0",
        validBefore: String(NOW_SECONDS + 3600),
        nonce: "0x" + "34".repeat(32),
      },
    },
  };

  return { requirements, payload };
}

describe("casper network ids", () => {
  it("exposes the CAIP-2 mainnet and testnet ids", () => {
    expect(CASPER_MAINNET_NETWORK).toBe("casper:casper");
    expect(CASPER_TESTNET_NETWORK).toBe("casper:casper-test");
  });

  it("guards the casper:* family", () => {
    expect(isCasperNetworkId("casper:casper")).toBe(true);
    expect(isCasperNetworkId("casper:casper-test")).toBe(true);
    expect(isCasperNetworkId("canton:1220abc")).toBe(false);
    expect(isCasperNetworkId("casper:")).toBe(false);
    expect(isCasperNetworkId(42)).toBe(false);
  });

  it("parseCasperNetworkId throws on a non-casper id", () => {
    expect(parseCasperNetworkId("casper:casper")).toBe("casper:casper");
    expect(() => parseCasperNetworkId("eip155:1")).toThrow(/not a casper network id/);
  });
});

describe("casper shape guards", () => {
  it("accepts the well-formed fixture", () => {
    const { requirements, payload } = buildFixture();
    expect(isCasperPaymentRequirements(requirements)).toBe(true);
    expect(isCasperPaymentInner(payload.payload)).toBe(true);
  });

  it("rejects requirements missing the CEP-18 contract hash", () => {
    const { requirements } = buildFixture();
    const broken = { ...requirements, asset: { symbol: "wCSPR" } };
    expect(isCasperPaymentRequirements(broken)).toBe(false);
  });

  it("rejects an inner payload with a non-decimal value", () => {
    const { payload } = buildFixture();
    const inner = payload.payload;
    expect(
      isCasperPaymentInner({
        ...inner,
        authorization: { ...inner.authorization, value: "1.5" },
      }),
    ).toBe(false);
    expect(isCasperPaymentInner({ ...inner, authorization: undefined })).toBe(false);
    expect(isCasperPaymentInner(null)).toBe(false);
  });
});

describe("createExactCasperVerifier", () => {
  const verifier = createExactCasperVerifier(CASPER_TESTNET_NETWORK);

  it("accepts a well-formed payload matching its requirements", () => {
    const { requirements, payload } = buildFixture();
    const res = verifier.verify(payload, requirements);
    expect(res).toEqual({ isValid: true, payer: payload.payload.authorization.from });
  });

  it("rejects a scheme mismatch", () => {
    const { requirements, payload } = buildFixture();
    const res = verifier.verify({ ...payload, scheme: "exact-canton" }, requirements);
    expect(res).toMatchObject({ isValid: false, invalidReason: "scheme_mismatch" });
  });

  it("rejects a payload for a different casper network", () => {
    const { requirements, payload } = buildFixture();
    const res = verifier.verify({ ...payload, network: CASPER_MAINNET_NETWORK }, requirements);
    expect(res).toMatchObject({ isValid: false, invalidReason: "network_mismatch" });
  });

  it("rejects expired requirements", () => {
    const { requirements, payload } = buildFixture();
    const expired = { ...requirements, validBefore: "2001-01-01T00:00:00.000Z" };
    const res = verifier.verify({ ...payload, payload: payload.payload }, expired);
    expect(res).toMatchObject({ isValid: false, invalidReason: "requirements_expired" });
  });

  it("rejects an expired authorization window", () => {
    const { requirements, payload } = buildFixture();
    const inner = payload.payload;
    const res = verifier.verify(
      {
        ...payload,
        payload: {
          ...inner,
          authorization: { ...inner.authorization, validBefore: String(NOW_SECONDS - 10) },
        },
      },
      requirements,
    );
    expect(res).toMatchObject({ isValid: false, invalidReason: "requirements_expired" });
  });

  it("rejects an authorization paying the wrong recipient", () => {
    const { requirements, payload } = buildFixture();
    const inner = payload.payload;
    const res = verifier.verify(
      {
        ...payload,
        payload: {
          ...inner,
          authorization: { ...inner.authorization, to: "account-hash-" + "ff".repeat(32) },
        },
      },
      requirements,
    );
    expect(res).toMatchObject({ isValid: false, invalidReason: "requirements_hash_mismatch" });
  });

  it("rejects an authorization exceeding maxAmountRequired", () => {
    const { requirements, payload } = buildFixture();
    const inner = payload.payload;
    const res = verifier.verify(
      {
        ...payload,
        payload: {
          ...inner,
          authorization: { ...inner.authorization, value: "1000000001" },
        },
      },
      requirements,
    );
    expect(res).toMatchObject({ isValid: false, invalidReason: "requirements_hash_mismatch" });
  });

  it("rejects a missing public key", () => {
    const { requirements, payload } = buildFixture();
    const res = verifier.verify(
      { ...payload, payload: { ...payload.payload, publicKey: "" } },
      requirements,
    );
    expect(res).toMatchObject({ isValid: false, invalidReason: "missing_public_key" });
  });

  it("rejects a non-hex signature", () => {
    const { requirements, payload } = buildFixture();
    const res = verifier.verify(
      { ...payload, payload: { ...payload.payload, signature: "not-hex!" } },
      requirements,
    );
    expect(res).toMatchObject({ isValid: false, invalidReason: "bad_signature" });
  });
});

describe("registry integration", () => {
  it("dispatches by (scheme, network) alongside other verifiers", () => {
    const registry = createVerifierRegistry([
      createExactCasperVerifier(CASPER_TESTNET_NETWORK),
      createExactCasperVerifier(CASPER_MAINNET_NETWORK),
    ]);
    const { requirements, payload } = buildFixture();

    expect(registry.find("exact", CASPER_TESTNET_NETWORK)).toBeDefined();
    expect(registry.find("exact", "casper:nope")).toBeUndefined();
    expect(registry.verify(payload, requirements)).toMatchObject({ isValid: true });
    expect(registry.verify({ ...payload, network: "casper:nope" }, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "scheme_mismatch",
    });
  });
});
