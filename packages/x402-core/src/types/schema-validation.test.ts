import { describe, it, expect } from "vitest";
import { ValiError } from "valibot";
import {
  isCantonPaymentInner,
  parseCantonPaymentInner,
  isCantonPaymentRequirements,
  isX402PaymentRequirements,
  parseCantonPaymentRequirements,
  isCantonVerifyRequest,
  isX402Request,
} from "../index";
import type { CantonPaymentInner } from "./payment";
import type { CantonPaymentRequirements } from "./requirements";

const inner: CantonPaymentInner = {
  assetTransferMethod: "transfer-factory",
  payer: "alice::1220beef",
  preparedTransaction: "cHJlcGFyZWQ=",
  preparedTxHash: "deadbeef",
  signature: "cafe",
  publicKey: "cHVibGljS2V5",
  hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
};

const requirements: CantonPaymentRequirements = {
  scheme: "exact",
  network: "canton:devnet",
  amount: "100000000",
  asset: "CC",
  extra: { assetTransferMethod: "transfer-factory", executeBeforeSeconds: 120, instrumentId: { id: "Amulet", admin: "DSO::1220be58c29e" } },
  payTo: "merchant::1220dead",
  resource: "/api/resource",
  maxTimeoutSeconds: 60,
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
    // field in turn; the schema must reject all of them. hashingSchemeVersion is
    // the one optional field: the spec reads an absent one as V2.
    for (const key of Object.keys(inner) as (keyof CantonPaymentInner)[]) {
      const { [key]: _omitted, ...partial } = inner;
      expect(isCantonPaymentInner(partial)).toBe(key === "hashingSchemeVersion");
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
    expect(isCantonPaymentRequirements({ ...requirements, extra: { assetTransferMethod: "transfer-factory", executeBeforeSeconds: 120, instrumentId: { id: "Amulet" } } })).toBe(false);
  });

  it("rejects an empty string in any required field", () => {
    // Present but empty is not valid. `asset: ""` names no symbol, `payTo: ""`
    // no party. Each is checked on its own so one field's rule cannot stand in
    // for another's.
    for (const key of ["scheme", "network", "amount", "asset", "payTo", "resource"] as const) {
      expect(isCantonPaymentRequirements({ ...requirements, [key]: "" })).toBe(false);
    }
  });

  it("requires extra.assetTransferMethod, and only the value the spec names", () => {
    const { assetTransferMethod: _omitted, ...withoutMethod } = requirements.extra;
    expect(isCantonPaymentRequirements({ ...requirements, extra: withoutMethod })).toBe(false);
    // A reserved protocol key: read as the spec defines it, not passed through
    // as opaque scheme data. Case included — the value is a wire literal.
    for (const method of ["", "TRANSFER-FACTORY", "transfer-preapproval", "eip3009"]) {
      const extra = { ...requirements.extra, assetTransferMethod: method };
      expect(isCantonPaymentRequirements({ ...requirements, extra })).toBe(false);
    }
  });

  it("requires the payload's assetTransferMethod too, with the same single value", () => {
    // The spec requires the key in both `extra` and the payload.
    const { assetTransferMethod: _omitted, ...withoutMethod } = inner;
    expect(isCantonPaymentInner(withoutMethod)).toBe(false);
    for (const method of ["", "TRANSFER-FACTORY", "transfer-preapproval", "eip3009"]) {
      expect(isCantonPaymentInner({ ...inner, assetTransferMethod: method })).toBe(false);
    }
  });

  it("reads maxTimeoutSeconds as a duration, not as any number", () => {
    const { maxTimeoutSeconds: _omitted, ...withoutTimeout } = requirements;
    expect(isCantonPaymentRequirements(withoutTimeout)).toBe(false);
    for (const ok of [1, 60, 3600]) {
      expect(isCantonPaymentRequirements({ ...requirements, maxTimeoutSeconds: ok })).toBe(true);
    }
    // `v.number()` alone refuses NaN but admits every one of these, and none of
    // them is a time a client can be given.
    for (const bad of [0, -5, 1.5, Infinity, NaN, "60", null]) {
      expect(isCantonPaymentRequirements({ ...requirements, maxTimeoutSeconds: bad })).toBe(false);
    }
  });

  it("requires extra.executeBeforeSeconds, as a duration", () => {
    const { executeBeforeSeconds: _omitted, ...withoutHorizon } = requirements.extra;
    expect(isCantonPaymentRequirements({ ...requirements, extra: withoutHorizon })).toBe(false);
    for (const bad of [0, -1, 1.5, Infinity, NaN, "120"]) {
      const extra = { ...requirements.extra, executeBeforeSeconds: bad };
      expect(isCantonPaymentRequirements({ ...requirements, extra })).toBe(false);
    }
  });

  it("takes extra.memo as optional, and bounds it in BYTES", () => {
    const withMemo = (memo: unknown) => ({ ...requirements, extra: { ...requirements.extra, memo } });
    expect(isCantonPaymentRequirements(requirements)).toBe(true); // absent is fine
    expect(isCantonPaymentRequirements(withMemo("invoice-2024-001"))).toBe(true);
    // The spec's limit is 256 bytes of UTF-8, and an emoji is four of them — so
    // a character count would admit a memo four times over the limit.
    expect(isCantonPaymentRequirements(withMemo("a".repeat(256)))).toBe(true);
    expect(isCantonPaymentRequirements(withMemo("a".repeat(257)))).toBe(false);
    expect(isCantonPaymentRequirements(withMemo("\u{1F600}".repeat(64)))).toBe(true);
    expect(isCantonPaymentRequirements(withMemo("\u{1F600}".repeat(65)))).toBe(false);
    // Present but empty is a key with nothing under it.
    expect(isCantonPaymentRequirements(withMemo(""))).toBe(false);
    expect(isCantonPaymentRequirements(withMemo(42))).toBe(false);
  });

  it("rejects an empty hash or signature in the inner payload", () => {
    // The verifier checks their encodings, but an empty one should not get
    // that far: present but empty is no hash and no signature.
    for (const key of ["preparedTxHash", "signature"] as const) {
      expect(isCantonPaymentInner({ ...inner, [key]: "" })).toBe(false);
    }
  });

  it("is at least as strict as the envelope it narrows", () => {
    // The concrete schema was LOOSER than the loose one: these all passed
    // isCantonPaymentRequirements while failing isX402PaymentRequirements.
    for (const key of ["scheme", "network", "amount", "asset", "payTo"] as const) {
      const bad = { ...requirements, [key]: "" };
      if (isX402PaymentRequirements(bad)) continue; // envelope rejects it...
      expect(isCantonPaymentRequirements(bad)).toBe(false); // ...so must this
    }
    // maxTimeoutSeconds is required for every scheme, so it is on the envelope
    // too — otherwise the narrowing guard would again be the stricter of the two.
    const { maxTimeoutSeconds: _omitted, ...withoutTimeout } = requirements;
    expect(isX402PaymentRequirements(withoutTimeout)).toBe(false);
    expect(isCantonPaymentRequirements(withoutTimeout)).toBe(false);
  });
});

describe("generic (loose) vs concrete (canton-exact) verify request", () => {
  const cantonReq = {
    x402Version: 2,
    paymentPayload: { x402Version: 2, scheme: "exact", network: requirements.network, payload: inner },
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
      amount: "1000000",
      payTo: "0xC0ffee",
      maxTimeoutSeconds: 60,
      asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    },
  };

  it("isX402Request accepts any scheme's envelope (scheme-agnostic dispatch gate)", () => {
    expect(isX402Request(cantonReq)).toBe(true);
    expect(isX402Request(bridgeReq)).toBe(true);
  });

  it("isCantonVerifyRequest accepts canton-exact but rejects another scheme's inner", () => {
    expect(isCantonVerifyRequest(cantonReq)).toBe(true);
    expect(isCantonVerifyRequest(bridgeReq)).toBe(false);
  });

  it("isX402Request rejects a malformed envelope", () => {
    expect(isX402Request({ x402Version: 2, paymentPayload: {}, paymentRequirements: {} })).toBe(false);
    expect(isX402Request({ x402Version: 2 })).toBe(false);
  });
});
