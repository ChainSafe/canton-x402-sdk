import { describe, it, expect } from "vitest";
import { HashingSchemeVersion } from "./index";
import type {
  CantonPaymentRequirements,
  CantonPaymentPayload,
  FacilitatorRequest,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "./index";

// These fixtures are type-checked by `tsc --noEmit`: if a wire type's shape
// changes incompatibly, the build fails here. The runtime assertions just give
// vitest something to run and pin the enum values.
describe("x402-core wire types", () => {
  it("accepts a well-formed exact-canton request envelope", () => {
    const requirements: CantonPaymentRequirements = {
      scheme: "exact-canton",
      network: "canton:1220be58c29e",
      maxAmountRequired: "0.01",
      asset: { instrumentId: { id: "Amulet", admin: "DSO::1220be58c29e" } },
      payTo: "merchant::1220dead",
      resource: "/api/resource",
      nonce: "550e8400-e29b-41d4-a716-446655440000",
      validBefore: "2026-01-01T00:00:00.000Z",
    };

    const payload: CantonPaymentPayload = {
      x402Version: 2,
      scheme: "exact-canton",
      network: requirements.network,
      payload: {
        payer: "alice::1220beef",
        preparedTransaction: "cHJlcGFyZWQ=",
        preparedTransactionHash: "deadbeef",
        partySignature: "cafe",
        keyFingerprint: "1220beef",
        transferFactoryId: "00factory",
        choiceContext: {},
        disclosedContracts: [
          {
            templateId: "pkg:Mod:Ent",
            contractId: "00abc",
            createdEventBlob: "YmxvYg==",
            synchronizerId: "global-domain::1220be58c29e",
          },
        ],
        requirementsHash: "0f1e2d",
        publicKey: "cHVibGljS2V5",
        hashingSchemeVersion: HashingSchemeVersion.V2,
      },
    };

    const envelope: FacilitatorRequest = {
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements: requirements,
    };

    const supported: SupportedResponse = {
      kinds: [{ x402Version: 2, scheme: "exact-canton", network: requirements.network }],
    };

    expect(envelope.x402Version).toBe(2);
    expect(supported.kinds).toHaveLength(1);
  });

  it("narrows the discriminated response unions", () => {
    const verifyOk: VerifyResponse = { isValid: true, payer: "alice::1220beef" };
    const verifyBad: VerifyResponse = { isValid: false, invalidReason: "bad_signature" };
    // `invalidReason` is only reachable after narrowing on `isValid`.
    if (verifyOk.isValid) expect(verifyOk.payer).toBe("alice::1220beef");
    if (!verifyBad.isValid) expect(verifyBad.invalidReason).toBe("bad_signature");

    const settleOk: SettleResponse = {
      success: true,
      network: "canton:1220be58c29e",
      transaction: "1220update",
      payer: "alice::1220beef",
    };
    const settleErr: SettleResponse = {
      success: false,
      errorReason: "execution_failed",
      errorDetails: "boom",
    };
    if (settleOk.success) expect(settleOk.transaction).toBe("1220update");
    if (!settleErr.success) expect(settleErr.errorReason).toBe("execution_failed");
  });

  it("exposes the hashing-scheme enum values", () => {
    expect(HashingSchemeVersion.V2).toBe("HASHING_SCHEME_VERSION_V2");
    expect(HashingSchemeVersion.V3).toBe("HASHING_SCHEME_VERSION_V3");
  });
});
