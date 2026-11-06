// The payload's `preparedTransaction` on the wire: base64 of exactly one gzip
// member. The Canton scheme spec's "Payload Encoding & Limits":
//
//   "The input MUST be exactly one gzip member: reject trailing bytes after the
//    member and concatenated members, and reject the optional filename /
//    comment / extra header fields."
//
//   "Decompress incrementally and abort as soon as either bound is exceeded: a
//    compressed-size cap (RECOMMENDED ~8 KiB of gzip data) and a
//    decompressed-size cap (RECOMMENDED ~64 KiB). Never allocate the output up
//    front from a declared size."
//
// The bytes come from the client before anything else is checked, so decoding
// them is attack surface. gunzip is not enough: it decodes concatenated members
// and drops trailing bytes without complaint, which are two of the shapes the
// spec says to refuse. So the member is framed by hand, as the scheme's
// reference implementation does: the fixed 10-byte header is parsed here, only
// the raw deflate body is inflated, the inflater must consume the whole body,
// and the member's own CRC32 and ISIZE are checked against what came out.
//
// This uses node:zlib, and core's entry point exports it, so all of core now
// needs Node (22.2 or later, for zlib.crc32) and no longer bundles for a browser.

import { crc32, gzipSync, inflateRawSync, type ZlibOptions } from "node:zlib";

/** The spec's recommended cap on the gzip member, in bytes. */
export const DEFAULT_MAX_COMPRESSED_BYTES = 8 * 1024;
/** The spec's recommended cap on the decompressed prepared transaction, in bytes. */
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 64 * 1024;

/**
 * The two bounds. The spec only recommends their values, so they can be set,
 * to positive whole numbers of bytes.
 */
export interface PreparedTransactionLimits {
  maxCompressedBytes?: number;
  maxDecompressedBytes?: number;
}

/**
 * A bound that is not a positive whole number is a caller's mistake, so it
 * throws rather than letting the bound go. NaN is the case that matters: every
 * comparison with it is false, and zlib reads a NaN maxOutputLength as unset,
 * so a NaN from an unset config value would turn both bounds off.
 */
function bound(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`gunzipPreparedTransaction: ${name} must be a positive whole number, got ${value}`);
  }
  return value;
}

const HEADER_BYTES = 10;
const TRAILER_BYTES = 8;
/**
 * Every flag but FTEXT: FHCRC, FEXTRA, FNAME, FCOMMENT and the reserved bits.
 * FTEXT carries no data, so with it the body always starts at byte 10 and
 * there is no header length for the client to choose.
 */
const FLAGS_REFUSED = 0xfe;

/**
 * The prepared transaction (the protobuf bytes `prepare` returned) in the form
 * the payload carries: base64 of one gzip member, with no optional header
 * fields. The header's OS byte is the platform's, so the output is the same on
 * one machine but not necessarily across platforms.
 */
export function gzipPreparedTransaction(preparedTransaction: Uint8Array): string {
  return gzipSync(preparedTransaction, { level: 9 }).toString("base64");
}

/**
 * The payload's `preparedTransaction` back to the protobuf bytes, or `null`
 * unless it is canonical standard base64 of exactly one gzip member within both
 * bounds. Never returns partial output, and never throws on the input; it
 * throws only on a malformed `limits`.
 *
 * {@link decodePreparedTransaction} reads these bytes, not the payload's value,
 * and so does a ledger's execute.
 */
export function gunzipPreparedTransaction(
  preparedTransaction: string,
  limits: PreparedTransactionLimits = {},
): Uint8Array | null {
  const maxCompressed = bound(limits.maxCompressedBytes, DEFAULT_MAX_COMPRESSED_BYTES, "maxCompressedBytes");
  const maxDecompressed = bound(
    limits.maxDecompressedBytes,
    DEFAULT_MAX_DECOMPRESSED_BYTES,
    "maxDecompressedBytes",
  );

  // The compressed cap first, on the base64 length, before decoding anything.
  if (preparedTransaction.length > Math.ceil(maxCompressed / 3) * 4) return null;
  // Buffer reads base64 leniently (URL-safe, whitespace, missing padding), so
  // the input must be exactly what encoding the decoded bytes gives back.
  const member = Buffer.from(preparedTransaction, "base64");
  if (member.toString("base64") !== preparedTransaction) return null;
  if (member.length > maxCompressed || member.length < HEADER_BYTES + TRAILER_BYTES) return null;

  // Magic, deflate, and no optional fields.
  if (member[0] !== 0x1f || member[1] !== 0x8b || member[2] !== 0x08) return null;
  if ((member[3] as number) & FLAGS_REFUSED) return null;

  const body = member.subarray(HEADER_BYTES, member.length - TRAILER_BYTES);
  let out: Buffer;
  let consumed: number;
  try {
    // maxOutputLength stops the inflater at the bound and throws: the
    // decompression-bomb defence. The declared ISIZE sizes nothing.
    const res = inflateRawSync(body, {
      maxOutputLength: maxDecompressed,
      info: true,
    } as ZlibOptions) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    out = res.buffer;
    consumed = res.engine.bytesWritten;
  } catch {
    return null;
  }

  // Raw inflate stops at the final deflate block and ignores what follows, so
  // a second member, or junk, could sit before the trailer and still decode to
  // the same bytes. The stream must end exactly where the trailer begins.
  if (consumed !== body.length) return null;
  const trailer = member.subarray(member.length - TRAILER_BYTES);
  if (out.length !== trailer.readUInt32LE(4)) return null;
  if (crc32(out) >>> 0 !== trailer.readUInt32LE(0)) return null;
  // A copy, not a view: zlib's output can sit in Node's shared Buffer pool, so
  // a view's `.buffer` would reach unrelated memory.
  return new Uint8Array(out);
}
