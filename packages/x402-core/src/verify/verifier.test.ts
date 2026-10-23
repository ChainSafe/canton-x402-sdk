import { describe, it, expect } from "vitest";
import { getPublicKey, hashes } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  computePreparedTransactionHash,
  createExactCantonVerifier,
  createVerifierRegistry,
  fingerprintForPublicKey,
  signHash,
} from "./index";
import { requirementsHash } from "../hashing";
import { HashingSchemeVersion } from "../types/payment";
import { encodePreparedTransaction } from "./prepared-tx.fixtures";
import type { CantonPaymentPayload, CantonPaymentRequirements, SchemeVerifier } from "../index";

hashes.sha512 = sha512;

const NETWORK = "canton:1220synchronizer";
const toB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

// A deterministic payer keypair + a well-formed, correctly-signed payload for it.
async function buildSignedFixture() {
  const seed = new Uint8Array(32).fill(3);
  const privateKey = toB64(seed);
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

  // A prepared-transaction blob whose TransferFactory_Transfer matches the
  // requirements (payer → payTo, the required Amulet, the required amount).
  const preparedTransaction = encodePreparedTransaction({
    sender: payer,
    receiver: requirements.payTo,
    amount: requirements.maxAmountRequired,
    instrumentId: requirements.asset.instrumentId,
  });
  const preparedTransactionHash = await computePreparedTransactionHash(
    preparedTransaction,
    HashingSchemeVersion.V2,
  );
  const partySignature = signHash(preparedTransactionHash, privateKey);

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
      hashingSchemeVersion: HashingSchemeVersion.V2,
    },
  };

  return { requirements, payload, payer, privateKey };
}

describe("exactCantonVerifier", () => {
  const verifier = createExactCantonVerifier(NETWORK);

  it("has the expected identity", () => {
    expect(verifier.schemeId).toBe("exact-canton");
    expect(verifier.networkId).toBe(NETWORK);
  });

  it("accepts a well-formed, correctly-signed payload", async () => {
    const { payload, requirements, payer } = await buildSignedFixture();
    const result = await verifier.verify(payload, requirements);
    expect(result).toEqual({ isValid: true, payer });
  });

  it("rejects a hash that is not bound to the prepared transaction", async () => {
    const { payload, requirements, privateKey } = await buildSignedFixture();
    const unrelatedHash = "aa".repeat(32);
    const maliciousPayload = {
      ...payload,
      payload: {
        ...payload.payload,
        preparedTransactionHash: unrelatedHash,
        partySignature: signHash(unrelatedHash, privateKey),
      },
    };

    const result = await verifier.verify(maliciousPayload, requirements);

    expect(result).toMatchObject({
      isValid: false,
      invalidReason: "prepared_transaction_hash_mismatch",
    });
  });

  it("rejects a scheme mismatch", async () => {
    const { payload, requirements } = await buildSignedFixture();
    const result = await verifier.verify(
      { ...payload, scheme: "batch-settlement-canton" },
      {
        ...requirements,
        scheme: "batch-settlement-canton",
      },
    );
    expect(result).toEqual({ isValid: false, invalidReason: "scheme_mismatch" });
  });

  it("rejects a network the verifier is not bound to", async () => {
    const { payload, requirements } = await buildSignedFixture();
    const other = "canton:1220other";
    const result = await verifier.verify(
      { ...payload, network: other },
      { ...requirements, network: other },
    );
    expect(result).toMatchObject({ isValid: false, invalidReason: "network_mismatch" });
  });

  it("rejects expired requirements", async () => {
    const { payload, requirements } = await buildSignedFixture();
    const expired = { ...requirements, validBefore: "2000-01-01T00:00:00.000Z" };
    // requirementsHash is bound to the requirements, so re-derive after mutating.
    const p = {
      ...payload,
      payload: { ...payload.payload, requirementsHash: requirementsHash(expired) },
    };
    expect(await verifier.verify(p, expired)).toMatchObject({
      isValid: false,
      invalidReason: "requirements_expired",
    });
  });

  it("rejects a requirementsHash that doesn't bind to the requirements", async () => {
    const { payload, requirements } = await buildSignedFixture();
    const p = { ...payload, payload: { ...payload.payload, requirementsHash: "deadbeef" } };
    expect(await verifier.verify(p, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "requirements_hash_mismatch",
    });
  });

  it("rejects a payer whose fingerprint doesn't match the public key", async () => {
    const { payload, requirements } = await buildSignedFixture();
    const p = { ...payload, payload: { ...payload.payload, payer: "mallory::1220wrong" } };
    // rebind the hash so we fail on fingerprint, not on the hash check
    const req = requirements;
    expect(await verifier.verify(p, req)).toMatchObject({
      isValid: false,
      invalidReason: "bad_fingerprint",
    });
  });

  it("rejects a bad signature", async () => {
    const { payload, requirements } = await buildSignedFixture();
    const p = { ...payload, payload: { ...payload.payload, partySignature: "ff".repeat(64) } };
    expect(await verifier.verify(p, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "bad_signature",
    });
  });

  it("reports missing_public_key for a blank OR absent key (specific reason, not internal_error)", async () => {
    const { payload, requirements } = await buildSignedFixture();
    // blank string
    const blank = { ...payload, payload: { ...payload.payload, publicKey: "" } };
    expect(await verifier.verify(blank, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "missing_public_key",
    });
    // entirely absent — the specific reason must survive the completed inner guard
    const { publicKey: _omit, ...innerNoKey } = payload.payload;
    const absent = { ...payload, payload: innerNoKey };
    expect(await verifier.verify(absent, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "missing_public_key",
    });
  });

  it("rejects a payload missing hashingSchemeVersion (internal_error)", async () => {
    const { payload, requirements } = await buildSignedFixture();
    const { hashingSchemeVersion: _omit, ...innerNoScheme } = payload.payload;
    const p = { ...payload, payload: innerNoScheme };
    expect(await verifier.verify(p, requirements)).toMatchObject({
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

  it("dispatches a payload to its verifier", async () => {
    const { payload, requirements, payer } = await buildSignedFixture();
    expect(await registry.verify(payload, requirements)).toEqual({ isValid: true, payer });
  });

  it("returns scheme_mismatch for an unregistered (scheme, network)", async () => {
    const { payload, requirements } = await buildSignedFixture();
    const p = { ...payload, network: "canton:1220unregistered" };
    expect(await registry.verify(p, requirements)).toEqual({
      isValid: false,
      invalidReason: "scheme_mismatch",
    });
  });

  it("adding a scheme = registering another SchemeVerifier (no dispatcher change)", async () => {
    // A second, non-Canton verifier slots into the same registry with no casts —
    // it just implements the SchemeVerifier contract over the widest envelope.
    const evmVerifier: SchemeVerifier = {
      schemeId: "exact-evm-to-canton-cc",
      networkId: "eip155:1",
      verify: () => Promise.resolve({ isValid: true, payer: "0xpayer" }),
    };
    const multi = createVerifierRegistry([verifier, evmVerifier]);
    const { payload, requirements, payer } = await buildSignedFixture();

    expect(await multi.verify(payload, requirements)).toEqual({ isValid: true, payer });
    const evmPayload = {
      x402Version: 2 as const,
      scheme: "exact-evm-to-canton-cc",
      network: "eip155:1",
      payload: {},
    };
    const evmReq = { ...requirements, scheme: "exact-evm-to-canton-cc", network: "eip155:1" };
    expect(await multi.verify(evmPayload, evmReq)).toEqual({ isValid: true, payer: "0xpayer" });
  });
});
