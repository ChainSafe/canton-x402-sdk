import { describe, it, expect } from "vitest";
import { getPublicKey, hashes } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  createExactCantonVerifier,
  createVerifierRegistry,
  EXACT_CANTON_SCHEME_ID,
  EXACT_SCHEME_ID,
  fingerprintForPublicKey,
  signHash,
} from "./index";
import { requirementsHash } from "../hashing";
import { encodePreparedTransaction } from "./prepared-tx.fixtures";
import type {
  CantonPaymentPayload,
  CantonPaymentRequirements,
  SchemeVerifier,
} from "../index";
import { SPEC_DEVNET_NETWORK } from "../networks";

hashes.sha512 = sha512;

const NETWORK = "canton:1220synchronizer";
const toB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

// A deterministic payer keypair + a well-formed, correctly-signed payload for it.
function buildSignedFixture() {
  const seed = new Uint8Array(32).fill(3);
  const pub = getPublicKey(seed);
  const pubB64 = toB64(pub);
  const fingerprint = fingerprintForPublicKey(pubB64);
  const payer = `alice::${fingerprint}`;

  const requirements: CantonPaymentRequirements = {
    scheme: "exact-canton",
    network: NETWORK,
    maxAmountRequired: "0.01",
    asset: { instrumentId: { id: "Amulet", admin: "DSO::1220dso" } },
    payTo: "merchant::1220merch",
    resource: "/api/resource",
    nonce: "550e8400-e29b-41d4-a716-446655440000",
    validBefore: "2999-01-01T00:00:00.000Z",
  };

  const preparedTransactionHash = "aa".repeat(32); // 32-byte hex message
  const partySignature = signHash(preparedTransactionHash, toB64(seed));

  // A prepared-transaction blob whose TransferFactory_Transfer matches the
  // requirements (payer → payTo, the required Amulet, the required amount).
  const preparedTransaction = encodePreparedTransaction({
    sender: payer,
    receiver: requirements.payTo,
    amount: requirements.maxAmountRequired,
    instrumentId: requirements.asset.instrumentId,
  });

  const payload: CantonPaymentPayload = {
    x402Version: 2,
    scheme: "exact-canton",
    network: NETWORK,
    payload: {
      payer,
      preparedTransaction,
      preparedTransactionHash,
      partySignature,
      requirementsHash: requirementsHash(requirements),
      publicKey: pubB64,
      hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
    },
  };

  return { requirements, payload, payer };
}

describe("exactCantonVerifier", () => {
  const verifier = createExactCantonVerifier(NETWORK);

  it("has the expected identity", () => {
    expect(verifier.schemeId).toBe("exact-canton");
    expect(verifier.networkId).toBe(NETWORK);
  });

  it("accepts a well-formed, correctly-signed payload", () => {
    const { payload, requirements, payer } = buildSignedFixture();
    const result = verifier.verify(payload, requirements);
    expect(result).toEqual({ isValid: true, payer });
  });

  it("rejects a scheme mismatch", () => {
    const { payload, requirements } = buildSignedFixture();
    const result = verifier.verify({ ...payload, scheme: "batch-settlement-canton" }, {
      ...requirements,
      scheme: "batch-settlement-canton",
    });
    expect(result).toEqual({ isValid: false, invalidReason: "scheme_mismatch" });
  });

  it("rejects a network the verifier is not bound to", () => {
    const { payload, requirements } = buildSignedFixture();
    const other = "canton:1220other";
    const result = verifier.verify({ ...payload, network: other }, { ...requirements, network: other });
    expect(result).toMatchObject({ isValid: false, invalidReason: "network_mismatch" });
  });

  it("rejects expired requirements", () => {
    const { payload, requirements } = buildSignedFixture();
    const expired = { ...requirements, validBefore: "2000-01-01T00:00:00.000Z" };
    // requirementsHash is bound to the requirements, so re-derive after mutating.
    const p = {
      ...payload,
      payload: { ...payload.payload, requirementsHash: requirementsHash(expired) },
    };
    expect(verifier.verify(p, expired)).toMatchObject({
      isValid: false,
      invalidReason: "requirements_expired",
    });
  });

  it("rejects a requirementsHash that doesn't bind to the requirements", () => {
    const { payload, requirements } = buildSignedFixture();
    const p = { ...payload, payload: { ...payload.payload, requirementsHash: "deadbeef" } };
    expect(verifier.verify(p, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "requirements_hash_mismatch",
    });
  });

  it("rejects a payer whose fingerprint doesn't match the public key", () => {
    const { payload, requirements } = buildSignedFixture();
    const p = { ...payload, payload: { ...payload.payload, payer: "mallory::1220wrong" } };
    // rebind the hash so we fail on fingerprint, not on the hash check
    const req = requirements;
    expect(verifier.verify(p, req)).toMatchObject({
      isValid: false,
      invalidReason: "bad_fingerprint",
    });
  });

  it("rejects a bad signature", () => {
    const { payload, requirements } = buildSignedFixture();
    const p = { ...payload, payload: { ...payload.payload, partySignature: "ff".repeat(64) } };
    expect(verifier.verify(p, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "bad_signature",
    });
  });

  it("reports missing_public_key for a blank OR absent key (specific reason, not internal_error)", () => {
    const { payload, requirements } = buildSignedFixture();
    // blank string
    const blank = { ...payload, payload: { ...payload.payload, publicKey: "" } };
    expect(verifier.verify(blank, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "missing_public_key",
    });
    // entirely absent — the specific reason must survive the completed inner guard
    const { publicKey: _omit, ...innerNoKey } = payload.payload;
    const absent = { ...payload, payload: innerNoKey };
    expect(verifier.verify(absent, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "missing_public_key",
    });
  });

  it("rejects a payload missing hashingSchemeVersion (internal_error)", () => {
    const { payload, requirements } = buildSignedFixture();
    const { hashingSchemeVersion: _omit, ...innerNoScheme } = payload.payload;
    const p = { ...payload, payload: innerNoScheme };
    expect(verifier.verify(p, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "internal_error",
    });
  });
});

describe("createVerifierRegistry", () => {
  const verifier = createExactCantonVerifier(NETWORK);
  const registry = createVerifierRegistry([verifier]);

  it("finds a registered verifier by (scheme, network)", () => {
    expect(registry.find("exact-canton", NETWORK)).toBe(verifier);
    expect(registry.find("exact-canton", "canton:1220other")).toBeUndefined();
    expect(registry.find("unknown-scheme", NETWORK)).toBeUndefined();
  });

  it("dispatches a payload to its verifier", () => {
    const { payload, requirements, payer } = buildSignedFixture();
    expect(registry.verify(payload, requirements)).toEqual({ isValid: true, payer });
  });

  it("returns scheme_mismatch for an unregistered (scheme, network)", () => {
    const { payload, requirements } = buildSignedFixture();
    const p = { ...payload, network: "canton:1220unregistered" };
    expect(registry.verify(p, requirements)).toEqual({
      isValid: false,
      invalidReason: "scheme_mismatch",
    });
  });

  it("adding a scheme = registering another SchemeVerifier (no dispatcher change)", () => {
    // A second, non-Canton verifier slots into the same registry with no casts —
    // it just implements the SchemeVerifier contract over the widest envelope.
    const evmVerifier: SchemeVerifier = {
      schemeId: "exact-evm-to-canton-cc",
      networkId: "eip155:1",
      verify: () => ({ isValid: true, payer: "0xpayer" }),
    };
    const multi = createVerifierRegistry([verifier, evmVerifier]);
    const { payload, requirements, payer } = buildSignedFixture();

    expect(multi.verify(payload, requirements)).toEqual({ isValid: true, payer });
    const evmPayload = { x402Version: 2 as const, scheme: "exact-evm-to-canton-cc", network: "eip155:1", payload: {} };
    const evmReq = { ...requirements, scheme: "exact-evm-to-canton-cc", network: "eip155:1" };
    expect(multi.verify(evmPayload, evmReq)).toEqual({ isValid: true, payer: "0xpayer" });
  });
});

describe("exactCantonVerifier scheme/network migration", () => {
  const OTHER_NETWORK = SPEC_DEVNET_NETWORK;

  /**
   * The fixture re-pointed at another scheme/network. `requirementsHash` walks
   * the whole requirements object, so changing either re-derives it — a payload
   * paying `exact` must be bound to requirements that say `exact`.
   */
  function fixtureFor(scheme: string, network: string) {
    const { payload, requirements, payer } = buildSignedFixture();
    const req = { ...requirements, scheme, network };
    return {
      payer,
      requirements: req,
      payload: {
        ...payload,
        scheme,
        network,
        payload: { ...payload.payload, requirementsHash: requirementsHash(req) },
      },
    };
  }

  const verifies = (v: SchemeVerifier, scheme: string, network = NETWORK) => {
    const f = fixtureFor(scheme, network);
    return v.verify(f.payload, f.requirements);
  };

  // Stage 1 — today. Nothing passed, nothing changes.
  describe("before the migration", () => {
    const verifier = createExactCantonVerifier(NETWORK);

    it("advertises and accepts only the id we have always used", () => {
      expect(verifier.schemeId).toBe(EXACT_CANTON_SCHEME_ID);
      expect(verifies(verifier, EXACT_CANTON_SCHEME_ID)).toMatchObject({ isValid: true });
      expect(verifies(verifier, EXACT_SCHEME_ID)).toEqual({
        isValid: false,
        invalidReason: "scheme_mismatch",
      });
    });
  });

  // Stage 2 — during. Lead with the spec's id, keep existing clients paying.
  describe("during the migration", () => {
    const verifier = createExactCantonVerifier(NETWORK, {
      schemeId: EXACT_SCHEME_ID,
      acceptSchemes: [EXACT_CANTON_SCHEME_ID],
    });

    it("advertises the spec's id", () => {
      expect(verifier.schemeId).toBe(EXACT_SCHEME_ID);
    });

    it("accepts both the advertised id and the one being retired", () => {
      expect(verifies(verifier, EXACT_SCHEME_ID)).toMatchObject({ isValid: true });
      expect(verifies(verifier, EXACT_CANTON_SCHEME_ID)).toMatchObject({ isValid: true });
    });

    it("still refuses an id that is neither", () => {
      expect(verifies(verifier, "exact-evm-to-canton-cc")).toEqual({
        isValid: false,
        invalidReason: "scheme_mismatch",
      });
    });

    it("refuses a payload and requirements that name DIFFERENT accepted ids", () => {
      // Both are accepted; they still have to agree. Paying `exact` against a
      // quote of `exact-canton` is two parties disagreeing about the contract.
      const { payload, requirements } = fixtureFor(EXACT_CANTON_SCHEME_ID, NETWORK);
      expect(
        verifier.verify({ ...payload, scheme: EXACT_SCHEME_ID }, requirements),
      ).toEqual({ isValid: false, invalidReason: "scheme_mismatch" });
    });
  });

  // Stage 3 — after. Retiring the legacy id is deleting one option.
  describe("after the migration", () => {
    const verifier = createExactCantonVerifier(NETWORK, { schemeId: EXACT_SCHEME_ID });

    it("no longer accepts the retired id", () => {
      expect(verifies(verifier, EXACT_SCHEME_ID)).toMatchObject({ isValid: true });
      expect(verifies(verifier, EXACT_CANTON_SCHEME_ID)).toEqual({
        isValid: false,
        invalidReason: "scheme_mismatch",
      });
    });
  });


  describe("networks migrate the same way", () => {
    it("accepts an additional network, advertises only the bound one", () => {
      const verifier = createExactCantonVerifier(NETWORK, {
        acceptNetworks: [OTHER_NETWORK],
      });
      expect(verifier.networkId).toBe(NETWORK);
      expect(verifies(verifier, EXACT_CANTON_SCHEME_ID, OTHER_NETWORK)).toMatchObject({
        isValid: true,
      });
      expect(verifies(verifier, EXACT_CANTON_SCHEME_ID, "canton:1220other")).toMatchObject({
        isValid: false,
        invalidReason: "network_mismatch",
      });
    });
  });
});
