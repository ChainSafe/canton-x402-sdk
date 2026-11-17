// Canton's own primitives: key fingerprints, Ed25519 signing and verification,
// the encodings a payload carries them in, and the shape of a canton network id.
//
// Nothing here knows about x402. It would be the same code under a different
// payment scheme, which is why it is its own module — `canton-exact.ts` is
// about the ORDER a payment is checked in, and these are the facts it checks
// against. `primitives.test.ts` already tested exactly this set before the
// split, which is how the seam was found rather than chosen.
//
// SPDX-License-Identifier: Apache-2.0

import {
  sign as ed25519Sign,
  verify as ed25519Verify,
  hashes as ed25519Hashes,
} from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import type { NetworkId } from "../types/common";

// @noble/ed25519 v3 needs sha512 wired (same as the facilitator's wallet.ts).
ed25519Hashes.sha512 = sha512;

/** Canton hash-purpose tag for key fingerprints. */
const HASH_PURPOSE_FINGERPRINT = Uint8Array.of(0x00, 0x00, 0x00, 0x0c);

/** base64 → bytes. Isomorphic: `atob` is global in Node 18+ and browsers. */
export function base64ToBytes(b64: string): Uint8Array {
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

/**
 * Ed25519-sign a prepared-transaction hash (hex) with a base64 32-byte seed,
 * returning the signature as hex. Counterpart to {@link verifySignature} — the
 * signature it produces is exactly what `verifySignature` (and the facilitator)
 * accept.
 */
export function signHash(hashHex: string, privateKeyBase64: string): string {
  const seed = base64ToBytes(privateKeyBase64);
  if (seed.length !== 32) throw new Error("ed25519 private key must be a 32-byte seed");
  return bytesToHex(ed25519Sign(hexToBytes(hashHex), seed));
}


/** 32 bytes as lower-case hex: the only form `preparedTxHash` takes. */
export const PREPARED_TX_HASH = /^[0-9a-f]{64}$/;

/** Standard alphabet, padded, nothing else. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** 64 bytes always encode to 88 characters of padded base64. */
const SIGNATURE_BASE64_LENGTH = 88;

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * A hex Ed25519 signature (what {@link signHash} returns) in the base64 form the
 * payload's `signature` carries.
 */
export function signatureToBase64(signatureHex: string): string {
  return bytesToBase64(hexToBytes(signatureHex));
}

/**
 * The payload's `signature` back to hex, for {@link verifySignature}. `null`
 * unless it is canonical standard base64 of exactly 64 bytes. A hex signature
 * is valid base64 (its 128 characters decode to 96 bytes), so the length check
 * is what keeps it from being read as one. Canonical means the encoding
 * {@link signatureToBase64} produces: no URL-safe alphabet, no missing padding,
 * no non-zero padding bits.
 *
 * The length is checked first because the value comes from the client. Run on
 * a few million characters, the regex below exhausts V8's backtracking stack
 * and throws instead of returning false.
 */
export function signatureFromBase64(signatureBase64: string): string | null {
  if (signatureBase64.length !== SIGNATURE_BASE64_LENGTH || !BASE64.test(signatureBase64)) {
    return null;
  }
  const bytes = base64ToBytes(signatureBase64);
  if (bytes.length !== 64 || bytesToBase64(bytes) !== signatureBase64) return null;
  return bytesToHex(bytes);
}

// ─── canton network-id boundary guard ──────────────────────────────────────
// NetworkId is a plain string (scheme-generic); this validates the `canton:<name>`
// form at untrusted boundaries (env, raw input). Shape only — that the name is
// one this deployment settles is the verifier's network check, not this guard's.

export function isCantonNetworkId(x: unknown): x is NetworkId {
  return typeof x === "string" && /^canton:.+/.test(x);
}

export function parseCantonNetworkId(s: string): NetworkId {
  if (!isCantonNetworkId(s)) throw new Error(`not a canton network id: ${s}`);
  return s;
}
