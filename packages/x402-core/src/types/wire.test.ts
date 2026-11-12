import { describe, it, expect } from "vitest";
import { HashingSchemeVersion } from "./index";
import type {
  CantonPaymentRequirements,
  CantonPaymentPayload,
  CantonPaymentRequiredResponse,
  CantonPaymentObjectRequest,
  CantonPaymentObjectResponse,
  VerifyRequest,
  SettleRequest,
  SettleResponse,
  SchemeVerifier,
  SupportedResponse,
  VerifyResponse,
  X402PaymentPayload,
  X402PaymentRequirements,
  X402PaymentRequiredResponse,
  X402Request,
} from "./index";

// These fixtures are type-checked by `tsc --noEmit`: if a wire type's shape
// changes incompatibly, the build fails here. The runtime assertions just give
// vitest something to run and pin the enum values.
describe("x402-core wire types", () => {
  it("accepts a well-formed canton-exact request envelope", () => {
    const requirements: CantonPaymentRequirements = {
      scheme: "exact",
      network: "canton:devnet",
      amount: "100000000",
      asset: "CC",
      extra: { assetTransferMethod: "transfer-factory", synchronizerId: "global-domain::1220be58c29e", executeBeforeSeconds: 120, instrumentId: { id: "Amulet", admin: "DSO::1220be58c29e" } },
      payTo: "merchant::1220dead",
      maxTimeoutSeconds: 60,
    };

    const payload: CantonPaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: {
        assetTransferMethod: "transfer-factory",
    preparedTransaction: "cHJlcGFyZWQ=",
        preparedTxHash: "deadbeef",
        signature: "cafe",
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
      kinds: [{ x402Version: 2, scheme: "exact", network: requirements.network }],
    };

    const paymentRequired: CantonPaymentRequiredResponse = {
      x402Version: 2,
      resource: { url: "https://merchant.example/api/resource", description: "A report" },
      accepts: [requirements],
      error: "payment_required",
    };

    // The generic payment and the canton-exact one assign to each other, so a
    // payer can build either and hand it to what takes the other.
    const generic: X402PaymentPayload = payload;
    const canton: CantonPaymentPayload = generic;

    expect(verifyReq.x402Version).toBe(2);
    expect(settleReq.paymentPayload).toBe(payload);
    expect(canton).toBe(payload);
    expect(supported.kinds).toHaveLength(1);
    expect(paymentRequired.accepts[0]).toBe(requirements);
  });

  it("expresses a second scheme's payload and extra via the generics — no casts", async () => {
    // A future EVM→Canton scheme: different inner payload and `extra` bag. It
    // instantiates the X402* generics directly; the fact that this block
    // type-checks (no `as`/`as unknown as`) is the acceptance criterion.
    //
    // `asset` is NOT a seam — the spec types it as a string for every scheme, so
    // EVM puts a token address where we put a symbol. The chain is already in
    // `network`. Anything an asset cannot say as a string goes in `extra`.
    interface EvmInner {
      ethereumTxHash: string;
      quoteId: string;
      quoteSignature: string;
    }
    interface EvmExtra {
      cantonRecipient: string;
    }

    const requirements: X402PaymentRequirements<EvmExtra> = {
      scheme: "exact-evm-to-canton-cc",
      network: "eip155:1",
      amount: "1000000",
      asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      payTo: "merchant::1220dead",
      maxTimeoutSeconds: 60,
      extra: { cantonRecipient: "merchant::1220dead" },
    };

    const payload: X402PaymentPayload<EvmInner, EvmExtra> = {
      x402Version: 2,
      accepted: requirements,
      payload: {
        ethereumTxHash: "0xfeed",
        quoteId: "q-1",
        quoteSignature: "0xsig",
      },
    };

    const request: X402Request<EvmInner, EvmExtra> = {
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements: requirements,
    };

    // Seams stay strongly typed on the way out — no widening to unknown.
    expect(request.paymentPayload.payload.ethereumTxHash).toBe("0xfeed");
    expect(request.paymentRequirements.asset).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(request.paymentRequirements.extra?.cantonRecipient).toBe("merchant::1220dead");
    expect(request.paymentPayload.accepted.extra?.cantonRecipient).toBe("merchant::1220dead");

    // ...and the request reaches the scheme-agnostic verifier contract as it is.
    const verifier: SchemeVerifier = {
      schemeId: "exact-evm-to-canton-cc",
      networkId: "eip155:1",
      verify: () => Promise.resolve({ isValid: true }),
    };
    await expect(verifier.verify(request.paymentPayload, request.paymentRequirements)).resolves.toEqual({
      isValid: true,
    });
  });

  it("carries a mixed-scheme accepts[] in one 402 (union type argument)", () => {
    // A 402 may advertise several schemes at once. X402PaymentRequiredResponse is
    // generic over the accepts element, so a union of two schemes' requirements —
    // with different `extra` seams — assigns to one accepts[] with no casts.
    // That the value type-checks IS the acceptance criterion.
    type BridgeRequirements = X402PaymentRequirements<{ cantonRecipient: string }>;

    const canton: CantonPaymentRequirements = {
      scheme: "exact",
      network: "canton:devnet",
      amount: "100000000",
      asset: "CC",
      extra: { assetTransferMethod: "transfer-factory", synchronizerId: "global-domain::1220be58c29e", executeBeforeSeconds: 120, instrumentId: { id: "Amulet", admin: "DSO::1220be58c29e" } },
      payTo: "merchant::1220dead",
      maxTimeoutSeconds: 60,
    };
    const bridge: BridgeRequirements = {
      scheme: "batch-settlement-canton",
      network: "eip155:1",
      amount: "1000000",
      asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      payTo: "0xC0ffee",
      maxTimeoutSeconds: 60,
      extra: { cantonRecipient: "merchant::1220dead" },
    };

    const offer: X402PaymentRequiredResponse<CantonPaymentRequirements | BridgeRequirements> = {
      x402Version: 2,
      resource: { url: "https://merchant.example/api/resource" },
      accepts: [canton, bridge], // heterogeneous — both schemes in one accepts[]
      error: "payment_required",
    };

    expect(offer.accepts).toHaveLength(2);
    // Fields shared by every scheme are reachable on the union without a cast.
    expect(offer.accepts.map((a) => a.scheme)).toEqual(["exact", "batch-settlement-canton"]);
    expect(offer.accepts.every((a) => a.payTo.length > 0)).toBe(true);
    // (Reaching a scheme-specific `extra` needs a proper discriminant on
    // `scheme` — a literal union — which is the separate `Scheme`-open-union item.)
  });

  it("narrows the discriminated response unions", () => {
    const verifyOk: VerifyResponse = { isValid: true, payer: "alice::1220beef" };
    const verifyBad: VerifyResponse = { isValid: false, invalidReason: "bad_signature" };
    // The spec's codes, which this core's verifier answers with, and an older
    // facilitator's, which still parse.
    const verifySpec: VerifyResponse = {
      isValid: false,
      invalidReason: "invalid_exact_canton_amount_mismatch",
      extensions: { reason: "transfer_mismatch", detail: "amount" },
    };
    const settleSpec: SettleResponse = { success: false, errorReason: "invalid_exact_canton_execute_failed" };
    const settlePending: SettleResponse = { success: false, errorReason: "settlement_pending" };
    expect([verifySpec, settleSpec, settlePending].every((r) => !("isValid" in r && r.isValid))).toBe(true);
    // `invalidReason` is only reachable after narrowing on `isValid`.
    if (verifyOk.isValid) expect(verifyOk.payer).toBe("alice::1220beef");
    if (!verifyBad.isValid) expect(verifyBad.invalidReason).toBe("bad_signature");

    const settleOk: SettleResponse = {
      success: true,
      network: "canton:devnet",
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
