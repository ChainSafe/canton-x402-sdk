import { describe, it, expect, vi } from "vitest";
import { getPublicKey, hashes } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  fingerprintForPublicKey,
  requirementsHash,
  verifySignature,
  type CantonPaymentRequirements,
} from "@chainsafe/x402-core";
import { CantonX402Payer, type CantonPartyKey, type CantonX402PayerOptions } from "./canton-payer";

hashes.sha512 = sha512;

const NETWORK = "canton:testfp";
const seed = new Uint8Array(32).fill(7);
const toB64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const publicKeyB64 = toB64(getPublicKey(seed));
const key: CantonPartyKey = {
  partyId: `payer::${fingerprintForPublicKey(publicKeyB64)}`,
  publicKey: publicKeyB64,
  privateKey: toB64(seed),
};

const preparedHashB64 = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");

function mockSdk() {
  const create = vi.fn(async () => [
    { ExerciseCommand: { templateId: "#pkg:Mod:Factory", contractId: "00factory" } },
    [{ templateId: "pkg:Mod:Ent", contractId: "00disc", createdEventBlob: "blob", synchronizerId: "sync::x" }],
  ]);
  const toJSON = vi.fn(async () => ({
    response: {
      preparedTransaction: "cHJlcGFyZWQ=",
      preparedTransactionHash: preparedHashB64,
      hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2" as const,
    },
  }));
  const prepare = vi.fn(() => ({ toJSON }));
  const sdk = { token: { transfer: { create } }, ledger: { prepare } } as unknown as CantonX402PayerOptions["sdk"];
  return { sdk, create, prepare };
}

function makeRequirements(over: Partial<CantonPaymentRequirements> = {}): CantonPaymentRequirements {
  return {
    scheme: "exact-canton",
    network: NETWORK,
    maxAmountRequired: "1.5",
    asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } },
    payTo: "merchant::y",
    resource: "https://api.example/report",
    nonce: "nonce-1",
    validBefore: "2999-01-01T00:00:00.000Z",
    ...over,
  };
}

function makePayer(sdk: CantonX402PayerOptions["sdk"]) {
  return new CantonX402Payer({
    sdk,
    key,
    network: NETWORK,
    registries: [{ instrumentId: { id: "Amulet", admin: "DSO::x" }, registryUrl: "https://registry.example" }],
  });
}

describe("CantonX402Payer.authorize", () => {
  it("assembles a payload that verifies against core's primitives", async () => {
    const { sdk, create } = mockSdk();
    const req = makeRequirements();
    const result = await makePayer(sdk).authorize(req);
    const inner = result.payload;

    expect(result).toMatchObject({ x402Version: 2, scheme: "exact-canton", network: NETWORK });
    expect(inner.payer).toBe(key.partyId);
    expect(inner.publicKey).toBe(publicKeyB64);
    expect(inner.keyFingerprint).toBe(fingerprintForPublicKey(publicKeyB64));
    expect(inner.requirementsHash).toBe(requirementsHash(req));
    expect(inner.preparedTransaction).toBe("cHJlcGFyZWQ=");
    expect(inner.preparedTransactionHash).toBe(Buffer.from(preparedHashB64, "base64").toString("hex"));
    expect(inner.hashingSchemeVersion).toBe("HASHING_SCHEME_VERSION_V2");
    // The signature verifies with the same code the facilitator runs.
    expect(verifySignature(inner.preparedTransactionHash, inner.partySignature, publicKeyB64)).toBe(true);
    // Disclosed contracts mapped to core's shape.
    expect(inner.disclosedContracts[0]).toEqual({
      templateId: "pkg:Mod:Ent",
      contractId: "00disc",
      createdEventBlob: "blob",
      synchronizerId: "sync::x",
    });
    // transfer built from the requirements.
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ sender: key.partyId, recipient: "merchant::y", amount: "1.5", instrumentId: "Amulet" }),
    );
  });

  it("rejects an invalid amount before preparing", async () => {
    const { sdk, prepare } = mockSdk();
    await expect(makePayer(sdk).authorize(makeRequirements({ maxAmountRequired: "abc" }))).rejects.toThrow(/invalid amount/);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects a requirement for another network", async () => {
    const { sdk } = mockSdk();
    await expect(makePayer(sdk).authorize(makeRequirements({ network: "canton:other" }))).rejects.toThrow(/network/);
  });

  it("rejects an expired requirement", async () => {
    const { sdk } = mockSdk();
    await expect(
      makePayer(sdk).authorize(makeRequirements({ validBefore: "2000-01-01T00:00:00.000Z" })),
    ).rejects.toThrow(/expired/);
  });

  it("supports() gates on scheme, network, and a configured asset", () => {
    const payer = makePayer(mockSdk().sdk);
    expect(payer.supports(makeRequirements())).toBe(true);
    expect(payer.supports(makeRequirements({ scheme: "exact-evm" }))).toBe(false);
    expect(payer.supports(makeRequirements({ network: "canton:other" }))).toBe(false);
    // Unsupported asset (no registry configured for it).
    expect(
      payer.supports(makeRequirements({ asset: { instrumentId: { id: "USDCx", admin: "USDC::z" } } })),
    ).toBe(false);
  });

  it("rejects an asset with no configured registry", async () => {
    const { sdk, prepare } = mockSdk();
    await expect(
      makePayer(sdk).authorize(makeRequirements({ asset: { instrumentId: { id: "USDCx", admin: "USDC::z" } } })),
    ).rejects.toThrow(/unsupported requirement/);
    expect(prepare).not.toHaveBeenCalled();
  });
});
