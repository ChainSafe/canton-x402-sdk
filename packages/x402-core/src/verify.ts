import { verify as ed25519Verify, hashes as ed25519Hashes } from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import type { NetworkId } from "./types/common";
import type { CantonPaymentInner, CantonPaymentPayload } from "./types/payment";
import type { CantonPaymentRequirements } from "./types/requirements";
import type { VerifyRequest } from "./types/facilitator";

// Pure, stateless verify primitives. Anything stateful (nonce replay, on-chain
// proof) stays in the facilitator/server — not here.
//
// @noble/ed25519 v3 needs sha512 wired (same as the facilitator's wallet.ts).
ed25519Hashes.sha512 = sha512;

/** Canton hash-purpose tag for key fingerprints. */
const HASH_PURPOSE_FINGERPRINT = Uint8Array.of(0x00, 0x00, 0x00, 0x0c);

/** base64 → bytes. Isomorphic: `atob` is global in Node 18+ and browsers. */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Canton key fingerprint for a base64 Ed25519 public key:
 * `1220` + hex(SHA-256(0x0000000c ‖ pubkey)). Must equal the payer party's
 * `::<fingerprint>` suffix. Ported from the facilitator (parity-tested).
 */
export function fingerprintForPublicKey(publicKeyBase64: string): string {
  const pk = base64ToBytes(publicKeyBase64);
  if (pk.length !== 32) throw new Error("ed25519 public key must be 32 bytes");
  return "1220" + bytesToHex(sha256(concatBytes(HASH_PURPOSE_FINGERPRINT, pk)));
}

/** True iff the public key's fingerprint equals the claimed one (case-insensitive). */
export function matchesFingerprint(publicKeyBase64: string, claimedFingerprint: string): boolean {
  return fingerprintForPublicKey(publicKeyBase64).toLowerCase() === claimedFingerprint.toLowerCase();
}

/**
 * Verify an Ed25519 signature (hex) over a prepared-transaction hash (hex) with a
 * base64 public key. Length-checks defensively; returns false on any error.
 */
export function verifySignature(
  hashHex: string,
  signatureHex: string,
  publicKeyBase64: string,
): boolean {
  try {
    const pk = base64ToBytes(publicKeyBase64);
    const sig = hexToBytes(signatureHex);
    const msg = hexToBytes(hashHex);
    if (pk.length !== 32 || sig.length !== 64) return false;
    return ed25519Verify(sig, msg, pk);
  } catch {
    return false;
  }
}

/** Decimal string with up to 10 fractional places (matches `maxAmountRequired`). */
export function isValidAmount(amount: string): boolean {
  return /^\d+(\.\d{1,10})?$/.test(amount);
}

/** True iff `validBefore` (ISO 8601) is unparseable or at/before `now` (expired). */
export function isExpired(validBefore: string, now: number = Date.now()): boolean {
  const t = Date.parse(validBefore);
  return !Number.isFinite(t) || t <= now;
}

/** The payload's scheme + network must match the requirements. */
export function schemeNetworkMatches(
  payload: CantonPaymentPayload,
  requirements: CantonPaymentRequirements,
): boolean {
  return payload.scheme === requirements.scheme && payload.network === requirements.network;
}

// ─── canton network-id boundary guard ──────────────────────────────────────
// NetworkId is a plain string (scheme-generic); this validates the exact-canton
// `canton:<synchronizer-id>` form at untrusted boundaries (env, raw input).

export function isCantonNetworkId(x: unknown): x is NetworkId {
  return typeof x === "string" && /^canton:.+/.test(x);
}

export function parseCantonNetworkId(s: string): NetworkId {
  if (!isCantonNetworkId(s)) throw new Error(`not a canton network id: ${s}`);
  return s;
}

// ─── structural shape guards (type predicates) ─────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function isCantonPaymentRequirements(v: unknown): v is CantonPaymentRequirements {
  if (!isObj(v)) return false;
  return (
    typeof v.scheme === "string" &&
    typeof v.network === "string" &&
    typeof v.maxAmountRequired === "string" &&
    typeof v.payTo === "string" &&
    typeof v.resource === "string" &&
    typeof v.nonce === "string" &&
    typeof v.validBefore === "string" &&
    isObj(v.asset)
  );
}

export function isCantonPaymentInner(v: unknown): v is CantonPaymentInner {
  if (!isObj(v)) return false;
  return (
    typeof v.payer === "string" &&
    typeof v.preparedTransaction === "string" &&
    typeof v.preparedTransactionHash === "string" &&
    typeof v.partySignature === "string" &&
    typeof v.keyFingerprint === "string" &&
    typeof v.requirementsHash === "string"
  );
}

/**
 * Loose guard for the outer `CantonPaymentPayload` envelope: any non-empty scheme
 * (per-scheme handlers validate the inner `payload` shape), x402 v2, a network,
 * and a `payload` object. Intentionally does NOT assert the inner exact-canton
 * fields — use {@link isCantonPaymentInner} for that.
 */
export function isCantonPaymentPayload(v: unknown): v is CantonPaymentPayload {
  if (!isObj(v)) return false;
  return (
    v.x402Version === 2 &&
    typeof v.scheme === "string" &&
    v.scheme.length > 0 &&
    typeof v.network === "string" &&
    isObj(v.payload)
  );
}

export function isVerifyRequest(v: unknown): v is VerifyRequest {
  if (!isObj(v)) return false;
  const payload = v.paymentPayload;
  return (
    v.x402Version === 2 &&
    isObj(payload) &&
    isCantonPaymentInner(payload.payload) &&
    isCantonPaymentRequirements(v.paymentRequirements)
  );
}
