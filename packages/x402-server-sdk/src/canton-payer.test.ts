import { describe, it, expect, vi } from "vitest";
import { getPublicKey, hashes } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  fingerprintForPublicKey,
  gunzipPreparedTransaction,
  signatureFromBase64,
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

/** The fields of the wallet SDK's transfer params these tests read back. */
interface TransferCall {
  expirationDate?: Date;
  meta?: { values: Record<string, string> };
  [key: string]: unknown;
}

function mockSdk() {
  const create = vi.fn(async (_params: TransferCall) => [
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

const EXTRA = {
  assetTransferMethod: "transfer-factory",
  executeBeforeSeconds: 120,
  instrumentId: { id: "Amulet", admin: "DSO::x" },
} as const;

function makeRequirements(over: Partial<CantonPaymentRequirements> = {}): CantonPaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: "15000000000",
    asset: "CC",
    extra: EXTRA,
    payTo: "merchant::y",
    resource: "https://api.example/report",
    maxTimeoutSeconds: 60,
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

    expect(result).toMatchObject({ x402Version: 2, scheme: "exact", network: NETWORK });
    expect(inner.assetTransferMethod).toBe("transfer-factory");
    expect(inner.publicKey).toBe(publicKeyB64);
    // The spec's payload names no payer (it is the transfer's sender, Rule 8),
    // and has no requirementsHash.
    for (const field of ["payer", "requirementsHash"]) expect(inner).not.toHaveProperty(field);
    // prepare's protobuf goes out gzipped, and gunzips back to the same bytes.
    expect(Buffer.from(inner.preparedTransaction, "base64").subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    expect(gunzipPreparedTransaction(inner.preparedTransaction)).toEqual(
      new Uint8Array(Buffer.from("cHJlcGFyZWQ=", "base64")),
    );
    // The hash goes out as hex and the signature as base64: the spec's encodings.
    expect(inner.preparedTxHash).toBe(Buffer.from(preparedHashB64, "base64").toString("hex"));
    expect(inner.hashingSchemeVersion).toBe("HASHING_SCHEME_VERSION_V2");
    expect(Buffer.from(inner.signature, "base64")).toHaveLength(64);
    // The signature verifies with the same code the facilitator runs.
    const signatureHex = signatureFromBase64(inner.signature);
    expect(signatureHex).not.toBeNull();
    expect(verifySignature(inner.preparedTxHash, signatureHex as string, publicKeyB64)).toBe(true);
    // transfer built from the requirements.
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ sender: key.partyId, recipient: "merchant::y", amount: "1.5", instrumentId: "Amulet" }),
    );
  });

  it("gives the transfer the quoted deadline, not the wallet SDK's default", async () => {
    // Left unset the SDK picks 24 hours, which would make the merchant's
    // horizon decorative and Rule 10 pass on every payment regardless.
    const { sdk, create } = mockSdk();
    const before = Date.now();
    await makePayer(sdk).authorize(makeRequirements({ extra: { ...EXTRA, executeBeforeSeconds: 300 } }));
    const { expirationDate } = create.mock.calls[0][0];
    if (!expirationDate) throw new Error("no expirationDate passed to the transfer");
    expect(expirationDate.getTime()).toBeGreaterThanOrEqual(before + 300_000);
    expect(expirationDate.getTime()).toBeLessThanOrEqual(Date.now() + 300_000);
  });

  it("writes a quoted memo under the scheme's own metadata key", async () => {
    // The SDK's own `memo` parameter writes a different key
    // (splice.lfdecentralizedtrust.org/reason), which Rule 12 does not read.
    const { sdk, create } = mockSdk();
    await makePayer(sdk).authorize(makeRequirements({ extra: { ...EXTRA, memo: "invoice-2024-001" } }));
    expect(create.mock.calls[0][0].meta).toEqual({ values: { "x402.memo": "invoice-2024-001" } });
  });

  it("sends no metadata when the merchant quoted no memo", async () => {
    const { sdk, create } = mockSdk();
    await makePayer(sdk).authorize(makeRequirements());
    expect(create.mock.calls[0][0].meta).toBeUndefined();
  });

  it("rejects an invalid amount before preparing", async () => {
    const { sdk, prepare } = mockSdk();
    await expect(makePayer(sdk).authorize(makeRequirements({ amount: "abc" }))).rejects.toThrow(/invalid amount/);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects a requirement for another network", async () => {
    const { sdk } = mockSdk();
    await expect(makePayer(sdk).authorize(makeRequirements({ network: "canton:other" }))).rejects.toThrow(/network/);
  });

  it("supports() gates on scheme, network, and a configured asset", () => {
    const payer = makePayer(mockSdk().sdk);
    expect(payer.supports(makeRequirements())).toBe(true);
    expect(payer.supports(makeRequirements({ scheme: "exact-evm" }))).toBe(false);
    expect(payer.supports(makeRequirements({ network: "canton:other" }))).toBe(false);
    // Unsupported asset (no registry configured for it).
    expect(
      payer.supports(makeRequirements({ asset: "USDCx", extra: { assetTransferMethod: "transfer-factory", executeBeforeSeconds: 120, instrumentId: { id: "USDCx", admin: "USDC::z" } } })),
    ).toBe(false);
  });

  it("supports() refuses requirements asking for another transfer method, so authorize never prepares", async () => {
    // A 402 body reaches the payer unvalidated, so the literal type is no guarantee.
    const { sdk, prepare } = mockSdk();
    const payer = makePayer(sdk);
    const other = makeRequirements({
      extra: { assetTransferMethod: "transfer-preapproval", instrumentId: { id: "Amulet", admin: "DSO::x" } },
    } as unknown as Partial<CantonPaymentRequirements>);
    expect(payer.supports(other)).toBe(false);
    await expect(payer.authorize(other)).rejects.toThrow(/unsupported requirement.*method "transfer-preapproval"/);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects an asset with no configured registry", async () => {
    const { sdk, prepare } = mockSdk();
    await expect(
      makePayer(sdk).authorize(makeRequirements({ asset: "USDCx", extra: { assetTransferMethod: "transfer-factory", executeBeforeSeconds: 120, instrumentId: { id: "USDCx", admin: "USDC::z" } } })),
    ).rejects.toThrow(/unsupported requirement/);
    expect(prepare).not.toHaveBeenCalled();
  });
});
