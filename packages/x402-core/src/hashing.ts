import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { X402PaymentRequirements } from "./types/requirements";

// RFC 8785 (JSON Canonicalization Scheme). The client and the facilitator both
// canonicalize PaymentRequirements identically and SHA-256 the UTF-8 bytes, so a
// payload signed for one (resource, amount, payTo) can't be replayed against
// another. `canonicalJson` is pure; only the hash pulls @noble/hashes (bundled).
// Ported verbatim from the facilitator's canonicalize.ts (kept byte-identical;
// see the parity test).
//
// Reference: https://datatracker.ietf.org/doc/html/rfc8785

/** Canonical JSON per RFC 8785 (JCS). Pure, dependency-free. */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

/**
 * requirementsHash — SHA-256 hex of the canonical PaymentRequirements. Binds a
 * signed payload to this exact (resource, amount, payTo, …). The canonicalizer
 * walks the whole object structurally, so it's scheme-agnostic in the asset/extra
 * seams — hence the widened `X402PaymentRequirements<unknown>` parameter.
 */
export function requirementsHash(requirements: X402PaymentRequirements<unknown>): string {
  return canonicalSha256Hex(requirements);
}

/** Internal: SHA-256 (hex) of the canonical JSON of a value. */
function canonicalSha256Hex(value: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(value))));
}

function serialize(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return serializeNumber(v);
  // JSON.stringify of a string is RFC 8259-compliant; for ASCII / Canton-ID
  // content it matches RFC 8785's forms.
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(serialize).join(",") + "]";
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    // Keys sorted lexicographically; `undefined` members dropped.
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + serialize(obj[k])).join(",") + "}";
  }
  throw new Error(`canonicalJson: unsupported value type ${typeof v}`);
}

function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error("canonicalJson: non-finite number not allowed");
  }
  // RFC 8785 mandates ECMAScript Number.prototype.toString ("shortest round-trip");
  // JSON.stringify(n) matches this for finite numbers.
  return JSON.stringify(n);
}
