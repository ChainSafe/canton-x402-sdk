import { describe, it, expect } from "vitest";
import { getPublicKey, sign, hashes } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  fingerprintForPublicKey,
  matchesFingerprint,
  verifySignature,
  signHash,
  isValidAmount,
  isExpired,
  schemeNetworkMatches,
  isCantonNetworkId,
  parseCantonNetworkId,
  isCantonPaymentRequirements,
  isCantonPaymentInner,
  isCantonPaymentPayload,
  isVerifyRequest,
} from "./verify";
import type { CantonPaymentPayload, CantonPaymentRequirements } from "./index";

hashes.sha512 = sha512; // wire ed25519 for key/sig generation in this test

const toB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

// Golden fingerprint from the FACILITATOR's fingerprintForPublicKey on a
// deterministic 32-byte (0x01) key. Pins byte-for-byte parity.
const PUBKEY_B64 = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const GOLDEN_FINGERPRINT = "1220974cb80e78f2fea077628a02faa4c57d68a65036eea27fb3463088a1c8527a99";

describe("fingerprint — facilitator parity", () => {
  it("matches the golden fingerprint", () => {
    expect(fingerprintForPublicKey(PUBKEY_B64)).toBe(GOLDEN_FINGERPRINT);
    expect(matchesFingerprint(PUBKEY_B64, GOLDEN_FINGERPRINT)).toBe(true);
    expect(matchesFingerprint(PUBKEY_B64, "1220deadbeef")).toBe(false);
  });
  it("rejects non-32-byte keys", () => {
    expect(() => fingerprintForPublicKey(btoa("short"))).toThrow();
  });
});

describe("verifySignature", () => {
  const priv = new Uint8Array(32).fill(7);
  const pub = getPublicKey(priv);
  const msg = new Uint8Array(32).fill(9);
  const sig = sign(msg, priv);
  const hashHex = bytesToHex(msg);
  const sigHex = bytesToHex(sig);
  const pubB64 = toB64(pub);

  it("accepts a valid signature", () => {
    expect(verifySignature(hashHex, sigHex, pubB64)).toBe(true);
  });
  it("rejects a tampered message", () => {
    expect(verifySignature(bytesToHex(new Uint8Array(32).fill(8)), sigHex, pubB64)).toBe(false);
  });
  it("rejects the wrong public key", () => {
    const otherPub = toB64(getPublicKey(new Uint8Array(32).fill(11)));
    expect(verifySignature(hashHex, sigHex, otherPub)).toBe(false);
  });
  it("rejects malformed lengths without throwing", () => {
    expect(verifySignature(hashHex, "abcd", pubB64)).toBe(false);
    expect(verifySignature(hashHex, sigHex, btoa("short"))).toBe(false);
  });
});

describe("signHash", () => {
  const priv = new Uint8Array(32).fill(7);
  const pub = getPublicKey(priv);
  const hashHex = bytesToHex(new Uint8Array(32).fill(9));

  it("produces a signature that verifySignature accepts (round-trip)", () => {
    const sig = signHash(hashHex, toB64(priv));
    expect(verifySignature(hashHex, sig, toB64(pub))).toBe(true);
  });
  it("throws on a non-32-byte seed", () => {
    expect(() => signHash(hashHex, btoa("short"))).toThrow(/32-byte seed/);
  });
});

describe("isValidAmount", () => {
  it("accepts decimals up to 10 places", () => {
    for (const ok of ["0", "1", "0.01", "10.1234567890"]) expect(isValidAmount(ok)).toBe(true);
  });
  it("rejects malformed amounts", () => {
    for (const bad of ["", "1.", ".5", "1.12345678901", "abc", "-1", "1e3", "1,5"])
      expect(isValidAmount(bad)).toBe(false);
  });
});

describe("isExpired", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  it("past / at-deadline / unparseable are expired; future is not", () => {
    expect(isExpired("2025-12-31T23:59:59.000Z", now)).toBe(true);
    expect(isExpired("2026-01-01T00:00:00.000Z", now)).toBe(true); // <= now
    expect(isExpired("2026-01-01T00:00:01.000Z", now)).toBe(false);
    expect(isExpired("not-a-date", now)).toBe(true);
  });
});

describe("canton network-id guard", () => {
  it("accepts canton:… and rejects other CAIP-2 / non-strings", () => {
    expect(isCantonNetworkId("canton:1220ab")).toBe(true);
    expect(isCantonNetworkId("eip155:1")).toBe(false);
    expect(isCantonNetworkId("canton:")).toBe(false);
    expect(isCantonNetworkId(123)).toBe(false);
    expect(parseCantonNetworkId("canton:1220ab")).toBe("canton:1220ab");
    expect(() => parseCantonNetworkId("eip155:1")).toThrow();
  });
});

describe("shape guards + scheme/network match", () => {
  const requirements = {
    scheme: "exact-canton",
    network: "canton:1220x",
    maxAmountRequired: "0.01",
    payTo: "merchant::1220x",
    resource: "/r",
    nonce: "n",
    validBefore: "2026-01-01T00:00:00.000Z",
    asset: { instrumentId: { id: "Amulet", admin: "DSO::1220x" } },
  } as CantonPaymentRequirements;
  const inner = {
    payer: "alice::1220x",
    preparedTransaction: "b",
    preparedTransactionHash: "h",
    partySignature: "s",
    requirementsHash: "rh",
    publicKey: "cHVibGljS2V5",
    hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
  };
  const payload = {
    x402Version: 2,
    scheme: "exact-canton",
    network: "canton:1220x",
    payload: inner,
  } as unknown as CantonPaymentPayload;

  it("validates well-formed shapes and rejects junk", () => {
    expect(isCantonPaymentRequirements(requirements)).toBe(true);
    expect(isCantonPaymentRequirements({})).toBe(false);
    expect(isCantonPaymentInner(inner)).toBe(true);
    expect(isCantonPaymentInner({})).toBe(false);
    // publicKey + hashingSchemeVersion are required — a payload missing either is rejected.
    expect(isCantonPaymentInner({ ...inner, publicKey: undefined })).toBe(false);
    expect(isCantonPaymentInner({ ...inner, hashingSchemeVersion: undefined })).toBe(false);
    expect(isCantonPaymentPayload(payload)).toBe(true);
    // Loose: accepts any non-empty scheme (per-scheme inner validated elsewhere).
    expect(
      isCantonPaymentPayload({
        x402Version: 2,
        scheme: "batch-settlement-canton",
        network: "canton:1220x",
        payload: { ethereumTxHash: "0x" },
      }),
    ).toBe(true);
    expect(isCantonPaymentPayload({ x402Version: 2, scheme: "", network: "canton:1220x", payload: {} })).toBe(false);
    expect(isCantonPaymentPayload({ x402Version: 1, scheme: "exact-canton", network: "n", payload: {} })).toBe(false);
    expect(isCantonPaymentPayload({})).toBe(false);
    expect(isVerifyRequest({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements })).toBe(true);
    expect(isVerifyRequest({ x402Version: 2 })).toBe(false);
  });

  it("matches scheme + network", () => {
    expect(schemeNetworkMatches(payload, requirements)).toBe(true);
    expect(schemeNetworkMatches({ ...payload, network: "canton:other" }, requirements)).toBe(false);
  });
});
