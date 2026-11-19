import { describe, it, expect } from "vitest";
import * as v from "valibot";
import { ValiError } from "valibot";
import {
  isCantonPaymentPayload,
  isCantonPaymentInner,
  isCantonPaymentRequirements,
  isX402PaymentRequirements,
  isCantonVerifyRequest,
  isX402Request,
  isCantonPaymentRequiredResponse,
  SettleErrorReasonSchema,
  SettleResponseSchema,
  SupportedResponseSchema,
  VerifyInvalidReasonSchema,
  VerifyResponseSchema,
} from "../index";
import {
  parseCantonPaymentInner,
} from "./payment";
import {
  parseCantonPaymentRequirements,
} from "./requirements";
import type { CantonPaymentInner } from "./payment";
import type { CantonPaymentRequirements } from "./requirements";

const inner: CantonPaymentInner = {
  assetTransferMethod: "transfer-factory",
    preparedTransaction: "cHJlcGFyZWQ=",
  preparedTxHash: "deadbeef",
  signature: "cafe",
  hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
};

const requirements: CantonPaymentRequirements = {
  scheme: "exact",
  network: "canton:devnet",
  amount: "100000000",
  asset: "CC",
  extra: { assetTransferMethod: "transfer-factory", synchronizerId: "global-domain::1220be58c29e", feePayer: "x402-facilitator::1220fee", executeBeforeSeconds: 120, instrumentId: { id: "Amulet", admin: "DSO::1220be58c29e" } },
  payTo: "merchant::1220dead",
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
    const { signature: _omit, ...noSignature } = inner;
    expect(() => parseCantonPaymentInner(noSignature)).toThrow(ValiError);
    try {
      parseCantonPaymentInner(noSignature);
    } catch (err) {
      const issues = (err as ValiError<typeof import("../types/payment").CantonPaymentInnerSchema>).issues;
      const path = issues[0]?.path?.map((p) => p.key).join(".");
      expect(path).toBe("signature");
    }
  });

  it("rejects wrong field types", () => {
    expect(isCantonPaymentInner({ ...inner, signature: 42 })).toBe(false);
    expect(isCantonPaymentRequirements({ ...requirements, extra: { assetTransferMethod: "transfer-factory", synchronizerId: "global-domain::1220be58c29e", feePayer: "x402-facilitator::1220fee", executeBeforeSeconds: 120, instrumentId: { id: "Amulet" } } })).toBe(false);
  });

  it("rejects an empty string in any required field", () => {
    // Present but empty is not valid. `asset: ""` names no symbol, `payTo: ""`
    // no party. Each is checked on its own so one field's rule cannot stand in
    // for another's.
    for (const key of ["scheme", "network", "amount", "asset", "payTo"] as const) {
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

  it("requires extra.feePayer, as a non-empty party string", () => {
    // The spec marks `memo` the only optional field of `extra`, so this one is
    // required like the rest — and a facilitator refuses a value naming anyone
    // but itself, which it cannot do with a field that was never sent.
    const { feePayer: _omitted, ...withoutFeePayer } = requirements.extra;
    expect(isCantonPaymentRequirements({ ...requirements, extra: withoutFeePayer })).toBe(false);
    for (const bad of ["", 42, null, true, []]) {
      const extra = { ...requirements.extra, feePayer: bad };
      expect(isCantonPaymentRequirements({ ...requirements, extra })).toBe(false);
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
    paymentPayload: { x402Version: 2, accepted: requirements, payload: inner },
    paymentRequirements: requirements,
  };
  // A different scheme: valid universal envelope, but the inner is NOT a CantonPaymentInner.
  const bridgeRequirements = {
    scheme: "batch-settlement-canton",
    network: "eip155:1",
    amount: "1000000",
    payTo: "0xC0ffee",
    maxTimeoutSeconds: 60,
    asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  };
  const bridgeReq = {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted: bridgeRequirements,
      payload: { evmTxHash: "0xfeed", quoteId: "q-1" },
    },
    paymentRequirements: bridgeRequirements,
  };

  it("isX402Request accepts any scheme's envelope (scheme-agnostic dispatch gate)", () => {
    expect(isX402Request(cantonReq)).toBe(true);
    expect(isX402Request(bridgeReq)).toBe(true);
  });

  it("takes a payment's accepted only as a whole PaymentRequirements, generic or canton-exact", () => {
    // The spec's accepted is the PaymentRequirements the payer chose. One that
    // names only the scheme and network is not one.
    for (const req of [cantonReq, bridgeReq]) {
      const { scheme, network } = req.paymentPayload.accepted;
      const partial = { ...req, paymentPayload: { ...req.paymentPayload, accepted: { scheme, network } } };
      expect(isX402Request(partial)).toBe(false);
      expect(isCantonVerifyRequest(partial)).toBe(false);
    }
    // Its extra is not checked: that is the per-scheme verifier's, against
    // paymentRequirements.
    const { extra: _omit, ...noExtra } = requirements;
    const noExtraReq = { ...cantonReq, paymentPayload: { ...cantonReq.paymentPayload, accepted: noExtra } };
    expect(isCantonVerifyRequest(noExtraReq)).toBe(true);
  });

  it("isCantonVerifyRequest accepts canton-exact but rejects another scheme's inner", () => {
    expect(isCantonVerifyRequest(cantonReq)).toBe(true);
    expect(isCantonVerifyRequest(bridgeReq)).toBe(false);
  });

  it("takes resource and extensions on the canton-exact payment, null included, and checks their shape", () => {
    const pay = cantonReq.paymentPayload;
    const ok = [
      { ...pay, resource: null, extensions: null },
      { ...pay, resource: { url: "https://m.example/r", description: null, tags: ["a"] }, extensions: { "x-ext": { info: {}, schema: {} } } },
    ];
    for (const paymentPayload of ok) {
      expect(isCantonPaymentPayload(paymentPayload)).toBe(true);
      expect(isCantonVerifyRequest({ ...cantonReq, paymentPayload })).toBe(true);
    }
    const bad = [
      { ...pay, resource: { description: "no url" } },
      { ...pay, resource: "https://m.example/r" },
      { ...pay, resource: { url: "https://m.example/r", tags: "a" } },
      { ...pay, extensions: "x" },
    ];
    for (const paymentPayload of bad) {
      expect(isCantonPaymentPayload(paymentPayload)).toBe(false);
      expect(isCantonVerifyRequest({ ...cantonReq, paymentPayload })).toBe(false);
    }
  });

  it("isX402Request rejects a malformed envelope", () => {
    expect(isX402Request({ x402Version: 2, paymentPayload: {}, paymentRequirements: {} })).toBe(false);
    // The pre-spec payment envelope: the scheme and network at the top level, no accepted.
    const legacy = { x402Version: 2, scheme: "exact", network: requirements.network, payload: inner };
    expect(isX402Request({ ...cantonReq, paymentPayload: legacy })).toBe(false);
    expect(isCantonVerifyRequest({ ...cantonReq, paymentPayload: legacy })).toBe(false);
    expect(isX402Request({ x402Version: 2 })).toBe(false);
  });
});

describe("PaymentRequired (the 402)", () => {
  const paymentRequired = {
    x402Version: 2,
    resource: { url: "https://merchant.example/r", description: "A report" },
    accepts: [requirements],
    error: "payment_required",
  };
  const valid = isCantonPaymentRequiredResponse;

  it("takes the spec's object, with extensions present, absent or null", () => {
    expect(valid(paymentRequired)).toBe(true);
    expect(valid({ ...paymentRequired, extensions: { "x-ext": { info: {} } } })).toBe(true);
    expect(valid({ ...paymentRequired, extensions: null })).toBe(true);
    // ResourceInfo fields this SDK does not know pass, as other servers may send them.
    expect(valid({ ...paymentRequired, resource: { url: "https://merchant.example/r", x: 1 } })).toBe(true);
    const { error: _omit, ...noError } = paymentRequired;
    expect(valid(noError)).toBe(true);
  });

  it("requires a top-level resource with a url, as the spec does", () => {
    const { resource: _omit, ...noResource } = paymentRequired;
    expect(valid(noResource)).toBe(false);
    for (const resource of [null, "https://merchant.example/r", {}, { url: "" }, { description: "no url" }]) {
      expect(valid({ ...paymentRequired, resource })).toBe(false);
    }
  });

  it("refuses another x402Version, and an extensions that is not an object", () => {
    expect(valid({ ...paymentRequired, x402Version: 1 })).toBe(false);
    expect(valid({ ...paymentRequired, extensions: "x" })).toBe(false);
  });
});

describe("reason codes", () => {
  // The Canton exact scheme spec's Error Reason Codes table, as written there.
  const schemeTable = [
    "invalid_exact_canton_missing_proof",
    "invalid_exact_canton_malformed_payload",
    "invalid_exact_canton_signature_invalid",
    "invalid_exact_canton_amount_mismatch",
    "invalid_exact_canton_merchant_mismatch",
    "invalid_exact_canton_instrument_id_mismatch",
    "invalid_exact_canton_preapproval_missing",
    "invalid_exact_canton_fee_payer_mismatch",
    "invalid_exact_canton_expired",
    "invalid_exact_canton_execute_before_too_far",
    "invalid_exact_canton_insufficient_inputs",
    "invalid_exact_canton_memo_mismatch",
    "invalid_exact_canton_merchant_not_registered",
    "invalid_exact_canton_self_payment",
    "invalid_exact_canton_execute_failed",
    "unexpected_canton_ledger_error",
    "settlement_pending",
    "invalid_network",
    "unsupported_scheme",
  ];
  const verifies = (invalidReason: string) => v.is(VerifyResponseSchema, { isValid: false, invalidReason });
  const settles = (errorReason: string) =>
    v.is(SettleResponseSchema, {
      success: false,
      errorReason,
      transaction: "",
      network: "canton:devnet",
    });

  it("keeps a settle failure's transaction, network and payer, so a pending answer names its transfer", () => {
    const pending = {
      success: false,
      errorReason: "settlement_pending",
      transaction: "ab".repeat(32),
      network: "canton:devnet",
      payer: "alice::1220beef",
    };
    expect(v.parse(SettleResponseSchema, pending)).toEqual(pending);
    expect(v.is(SettleResponseSchema, { ...pending, transaction: 42 })).toBe(false);
  });

  it("takes every code in the scheme spec's table, on verify and on settle", () => {
    for (const code of schemeTable) {
      expect(verifies(code), code).toBe(true);
      expect(settles(code), code).toBe(true);
    }
  });

  it("takes exactly the specs' codes plus the one declared extension, and nothing else", () => {
    // Frozen at 1.0.0: a picklist can only grow in a minor, so pin both lists
    // in full. Re-adding an older code, or dropping a spec code, fails here.
    const generalCodes = [
      "insufficient_funds",
      "invalid_payload",
      "invalid_payment_requirements",
      "invalid_scheme",
      "invalid_x402_version",
      "invalid_transaction_state",
      "unexpected_verify_error",
      "unexpected_settle_error",
    ];
    const expected = [
      ...schemeTable,
      ...generalCodes,
      "invalid_exact_canton_synchronizer_mismatch",
    ];
    expect(VerifyInvalidReasonSchema.options).toEqual(expected);
    expect(SettleErrorReasonSchema.options).toEqual(expected);
  });

  it("no longer takes the codes nothing produces, which 1.x cannot add back", () => {
    // The cost of the narrowing, stated: an answer from a facilitator on a
    // published 0.1.x carrying one of these no longer validates. That is the
    // trade — these were kept for exactly that case, and dropping them before
    // 1.0.0 was the last chance, since a picklist can only grow in a minor.
    for (const code of [
      "scheme_mismatch",
      "network_mismatch",
      "requirements_hash_mismatch",
      "bad_fingerprint",
      "bad_signature",
      "prepared_transaction_hash_mismatch",
      "invalid_prepared_transaction_structure",
      "missing_public_key",
      "transfer_mismatch",
      "transfer_expired",
      "internal_error",
      "nonce_replayed",
    ]) {
      expect(verifies(code), code).toBe(false);
    }
    for (const code of [
      "unauthorized",
      "scheme_mismatch",
      "network_mismatch",
      "requirements_hash_mismatch",
      "bad_fingerprint",
      "bad_signature",
      "facilitator_error",
      "nonce_replayed",
      "bad_request",
      "execution_failed",
      "timeout",
    ]) {
      expect(settles(code), code).toBe(false);
    }
  });

  it("refuses a code neither spec nor this SDK defines", () => {
    expect(verifies("invalid_exact_evm_payload_signature")).toBe(false);
    expect(settles("made_up")).toBe(false);
  });
});

describe("facilitator answers, in the shape x402 v2 gives them", () => {
  const refused = {
    success: false,
    errorReason: "invalid_exact_canton_execute_failed",
    transaction: "",
    network: "canton:devnet",
  };
  const settled = { success: true, network: "canton:devnet", transaction: "1220update" };

  it("requires a failed settle's transaction and network, empty when nothing was relayed", () => {
    expect(v.is(SettleResponseSchema, refused)).toBe(true);
    const { transaction: _t, ...noTransaction } = refused;
    const { network: _n, ...noNetwork } = refused;
    expect(v.is(SettleResponseSchema, noTransaction)).toBe(false);
    expect(v.is(SettleResponseSchema, noNetwork)).toBe(false);
  });

  it("keeps a failed settle's errorMessage, extensions and payer", () => {
    const full = {
      ...refused,
      errorMessage: "the ledger refused the transfer",
      payer: "alice::1220beef",
      extensions: { detail: "boom" },
    };
    expect(v.parse(SettleResponseSchema, full)).toEqual(full);
  });

  it("takes a success without a payer, keeps its amount, and drops the fields the spec does not define", () => {
    expect(v.parse(SettleResponseSchema, settled)).toEqual(settled);
    const withAmount = { ...settled, amount: "500000000" };
    expect(v.parse(SettleResponseSchema, { ...withAmount, completionOffset: "42" })).toEqual(
      withAmount,
    );
    expect(v.parse(SettleResponseSchema, { ...refused, errorDetails: "boom" })).toEqual(refused);
  });

  it("keeps a verify answer's extra, and an invalid one's invalidMessage", () => {
    const ok = { isValid: true, payer: "alice::1220beef", extra: { note: "x" } };
    const bad = {
      isValid: false,
      invalidReason: "invalid_exact_canton_amount_mismatch",
      invalidMessage: "the transfer moves another amount",
      extra: { note: "x" },
    };
    expect(v.parse(VerifyResponseSchema, ok)).toEqual(ok);
    expect(v.parse(VerifyResponseSchema, bad)).toEqual(bad);
  });

  describe("/supported", () => {
    // The example in x402 v2 §7.3, as written there.
    const example = {
      kinds: [
        { x402Version: 2, scheme: "exact", network: "eip155:84532" },
        { x402Version: 2, scheme: "exact", network: "eip155:8453" },
        { x402Version: 2, scheme: "exact", network: "eip155:43113" },
        { x402Version: 2, scheme: "exact", network: "eip155:43114" },
      ],
      extensions: [],
      signers: {
        "eip155:*": ["0x1234567890abcdef1234567890abcdef12345678"],
        "solana:*": ["CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5"],
      },
    };

    it("parses the spec's example as it is", () => {
      // toEqual, not just a pass: a record schema would take `extensions: []`
      // too, and turn it into `{}`.
      expect(v.parse(SupportedResponseSchema, example)).toEqual(example);
      const withIds = { ...example, extensions: ["bazaar"] };
      expect(v.parse(SupportedResponseSchema, withIds)).toEqual(withIds);
    });

    it("requires extensions as a list of ids and signers as lists of addresses, as §7.3.1 does", () => {
      const { extensions: _e, ...noExtensions } = example;
      const { signers: _s, ...noSigners } = example;
      for (const bad of [
        { kinds: [] },
        noExtensions,
        noSigners,
        { ...example, extensions: {} },
        { ...example, signers: { "canton:*": "x402-facilitator::1220fee" } },
        { ...example, signers: { "canton:*": [42] } },
      ]) {
        expect(v.is(SupportedResponseSchema, bad), JSON.stringify(bad)).toBe(false);
      }
    });
  });
});
