import { describe, it, expect } from "vitest";
import { HashingSchemeVersion } from "./index";
import type {
  CantonPaymentRequirements,
  CantonPaymentPayload,
  PaymentRequiredResponse,
  CantonPaymentObjectRequest,
  CantonPaymentObjectResponse,
  VerifyRequest,
  SettleRequest,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
  X402PaymentPayload,
  X402PaymentRequirements,
  X402Request,
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
        requirementsHash: "0f1e2d",
        publicKey: "cHVibGljS2V5",
        hashingSchemeVersion: HashingSchemeVersion.V2,
      },
    };

    const verifyReq: VerifyRequest = {
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements: requirements,
    };
    // SettleRequest is an alias of VerifyRequest — the identical envelope.
    const settleReq: SettleRequest = verifyReq;

    const supported: SupportedResponse = {
      kinds: [{ x402Version: 2, scheme: "exact-canton", network: requirements.network }],
    };

    const paymentRequired: PaymentRequiredResponse = {
      x402Version: 2,
      accepts: [requirements],
      error: "payment_required",
    };

    expect(verifyReq.x402Version).toBe(2);
    expect(settleReq.paymentPayload).toBe(payload);
    expect(supported.kinds).toHaveLength(1);
    expect(paymentRequired.accepts[0]).toBe(requirements);
  });

  it("expresses a second scheme's payload/asset/extra via the generics — no casts", () => {
    // A future EVM→Canton scheme: different inner payload, asset descriptor, and
    // `extra` bag. It instantiates the X402* generics directly; the fact that this
    // block type-checks (no `as`/`as unknown as`) is the acceptance criterion.
    interface EvmInner {
      ethereumTxHash: string;
      quoteId: string;
      quoteSignature: string;
    }
    interface EvmAsset {
      chainId: number;
      tokenAddress: string;
    }
    interface EvmExtra {
      cantonRecipient: string;
    }

    const requirements: X402PaymentRequirements<EvmAsset, EvmExtra> = {
      scheme: "exact-evm-to-canton-cc",
      network: "eip155:1",
      maxAmountRequired: "1000000",
      asset: { chainId: 1, tokenAddress: "0xA0b8…" },
      payTo: "merchant::1220dead",
      resource: "/api/resource",
      nonce: "550e8400-e29b-41d4-a716-446655440000",
      validBefore: "2026-01-01T00:00:00.000Z",
      extra: { cantonRecipient: "merchant::1220dead" },
    };

    const payload: X402PaymentPayload<EvmInner> = {
      x402Version: 2,
      scheme: "exact-evm-to-canton-cc",
      network: "eip155:1",
      payload: {
        ethereumTxHash: "0xfeed",
        quoteId: "q-1",
        quoteSignature: "0xsig",
      },
    };

    const request: X402Request<EvmInner, EvmAsset, EvmExtra> = {
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements: requirements,
    };

    // Seams stay strongly typed on the way out — no widening to unknown.
    expect(request.paymentPayload.payload.ethereumTxHash).toBe("0xfeed");
    expect(request.paymentRequirements.asset.chainId).toBe(1);
    expect(request.paymentRequirements.extra?.cantonRecipient).toBe("merchant::1220dead");
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

  it("accepts a payment-object request/response", () => {
    const req: CantonPaymentObjectRequest = {
      amount: "0.01",
      merchantParty: "merchant::1220dead",
      payerParty: "alice::1220beef",
      resource: "/api/resource",
      asset: { instrumentId: { id: "Amulet", admin: "DSO::1220be58c29e" } },
    };

    const res: CantonPaymentObjectResponse = {
      paymentObject: {
        amount: req.amount,
        merchantParty: req.merchantParty,
        payerParty: req.payerParty,
        expiresAt: "2026-01-01T00:00:00.000Z",
        resource: req.resource,
        facilitatorFee: "0.00",
        totalAmount: "0.01",
        transferFactory: {
          contractId: "00factory",
          disclosedContracts: [
            {
              templateId: "pkg:Mod:Ent",
              contractId: "00abc",
              createdEventBlob: "YmxvYg==",
              synchronizerId: "global-domain::1220be58c29e",
            },
          ],
        },
        choiceContext: { choiceContextData: { values: {} } },
      },
      paymentId: "pay-1",
      status: "ready",
    };

    expect(res.paymentObject.transferFactory.contractId).toBe("00factory");
    expect(res.status).toBe("ready");
    expect(req.asset?.instrumentId.id).toBe("Amulet");
  });

  it("exposes the hashing-scheme enum values", () => {
    expect(HashingSchemeVersion.V2).toBe("HASHING_SCHEME_VERSION_V2");
    expect(HashingSchemeVersion.V3).toBe("HASHING_SCHEME_VERSION_V3");
  });
});
