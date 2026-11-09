import { describe, it, expect, vi } from "vitest";
import { gzipSync } from "node:zlib";
import {
  DEFAULT_MAX_COMPRESSED_BYTES,
  DEFAULT_MAX_DECOMPRESSED_BYTES,
  gunzipPreparedTransaction,
  gzipPreparedTransaction,
} from "./prepared-tx-codec";

// About the size of a real prepared transfer (22-27 KB raw on mainnet), though
// far more compressible: 481 bytes gzipped, where a real one is about 5 KB.
const raw = new Uint8Array(25_000).map((_, i) => (i * 31 + (i >> 7)) & 0x3f);
const payload = gzipPreparedTransaction(raw);
const member = Buffer.from(payload, "base64");

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const withByte = (at: number, value: number): string => {
  const copy = Buffer.from(member);
  copy[at] = value;
  return b64(copy);
};

describe("gzipPreparedTransaction", () => {
  it("writes one gzip member with no optional header fields", () => {
    expect(member[0]).toBe(0x1f);
    expect(member[1]).toBe(0x8b);
    expect(member[2]).toBe(0x08);
    expect(member[3]).toBe(0);
    expect(member.readUInt32LE(4)).toBe(0); // mtime
  });
  it("gives the same output for the same input", () => {
    expect(gzipPreparedTransaction(raw)).toBe(payload);
  });
});

describe("gunzipPreparedTransaction", () => {
  it("round-trips", () => {
    expect(gunzipPreparedTransaction(payload)).toEqual(raw);
  });

  it("returns its own exact-size bytes, not a view into zlib's buffer", () => {
    const out = gunzipPreparedTransaction(payload)!;
    expect(out.byteOffset).toBe(0);
    expect(out.buffer.byteLength).toBe(out.length);
  });

  it("accepts a member made by any gzip without optional fields", () => {
    expect(gunzipPreparedTransaction(b64(gzipSync(raw, { level: 1 })))).toEqual(raw);
  });

  it("refuses base64 that is not canonical", () => {
    expect(payload).toMatch(/[+/]/); // so the URL-safe case below changes something
    for (const variant of [
      payload.replace(/\+/g, "-").replace(/\//g, "_"),
      payload.replace(/=+$/, ""),
      ` ${payload}`,
      `${payload}\n`,
    ]) {
      expect(gunzipPreparedTransaction(variant)).toBeNull();
    }
  });

  it("refuses a second member", () => {
    const two = Buffer.concat([member, gzipSync(Buffer.from("x"))]);
    expect(gunzipPreparedTransaction(b64(two))).toBeNull();
  });

  it("refuses bytes after the member", () => {
    expect(gunzipPreparedTransaction(b64(Buffer.concat([member, Buffer.from([0])])))).toBeNull();
  });

  it("refuses bytes between the deflate stream and the trailer", () => {
    // Raw inflate stops at the last block, so this still decodes to `raw` and
    // the trailer still matches. Only the consumed-bytes check refuses it.
    const junk = Buffer.concat([
      member.subarray(0, member.length - 8),
      Buffer.from([1, 2, 3, 4]),
      member.subarray(member.length - 8),
    ]);
    expect(gunzipPreparedTransaction(b64(junk))).toBeNull();
  });

  it("refuses every optional header flag and the reserved bits", () => {
    for (const flag of [0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80]) {
      expect(gunzipPreparedTransaction(withByte(3, flag))).toBeNull();
    }
    // FTEXT carries no data and moves nothing, so it is allowed.
    expect(gunzipPreparedTransaction(withByte(3, 0x01))).toEqual(raw);
  });

  it("refuses the wrong magic or compression method", () => {
    expect(gunzipPreparedTransaction(withByte(0, 0x1e))).toBeNull();
    expect(gunzipPreparedTransaction(withByte(1, 0x8c))).toBeNull();
    expect(gunzipPreparedTransaction(withByte(2, 0x07))).toBeNull();
  });

  it("refuses a trailer that does not match the output", () => {
    expect(gunzipPreparedTransaction(withByte(member.length - 8, member[member.length - 8]! ^ 1))).toBeNull();
    expect(gunzipPreparedTransaction(withByte(member.length - 4, member[member.length - 4]! ^ 1))).toBeNull();
  });

  it("refuses a corrupt deflate stream and anything too short", () => {
    expect(gunzipPreparedTransaction(withByte(10, 0xff))).toBeNull();
    expect(gunzipPreparedTransaction(b64(member.subarray(0, 17)))).toBeNull();
    expect(gunzipPreparedTransaction("")).toBeNull();
  });

  it("stops a decompression bomb at the decompressed cap", () => {
    // Deflate tops out near 1000:1, so 5 MiB of zeros is about 5 KB: inside
    // the compressed cap, so the decompressed cap is what has to stop it.
    const bomb = gzipSync(Buffer.alloc(5 * 1024 * 1024));
    expect(bomb.length).toBeLessThanOrEqual(DEFAULT_MAX_COMPRESSED_BYTES);
    expect(gunzipPreparedTransaction(b64(bomb))).toBeNull();
  });

  it("holds both caps exactly", () => {
    const atCap = new Uint8Array(DEFAULT_MAX_DECOMPRESSED_BYTES);
    expect(gunzipPreparedTransaction(gzipPreparedTransaction(atCap))).toEqual(atCap);
    expect(gunzipPreparedTransaction(gzipPreparedTransaction(new Uint8Array(atCap.length + 1)))).toBeNull();

    const limits = { maxCompressedBytes: member.length };
    expect(gunzipPreparedTransaction(payload, limits)).toEqual(raw);
    expect(gunzipPreparedTransaction(payload, { maxCompressedBytes: member.length - 1 })).toBeNull();
  });

  it("refuses an over-long input before decoding it", () => {
    // Megabytes of valid base64: the length bound answers before any of it is read.
    const from = vi.spyOn(Buffer, "from");
    try {
      expect(gunzipPreparedTransaction("A".repeat(8 * 1024 * 1024))).toBeNull();
      expect(from).not.toHaveBeenCalled();
    } finally {
      from.mockRestore();
    }
  });

  it("refuses a member one byte over the compressed cap", () => {
    // Stored blocks: 23 bytes of framing, so 8170 bytes in is 8193 out. Its
    // base64 is still within the length pre-check (8192 is not a multiple of 3),
    // so the byte count is what refuses it.
    const over = gzipSync(Buffer.alloc(8170, 7), { level: 0 });
    expect(over.length).toBe(DEFAULT_MAX_COMPRESSED_BYTES + 1);
    expect(b64(over).length).toBe(Math.ceil(DEFAULT_MAX_COMPRESSED_BYTES / 3) * 4);
    expect(gunzipPreparedTransaction(b64(over))).toBeNull();
    const at = gzipSync(Buffer.alloc(8169, 7), { level: 0 });
    expect(at.length).toBe(DEFAULT_MAX_COMPRESSED_BYTES);
    expect(gunzipPreparedTransaction(b64(at))).toEqual(new Uint8Array(Buffer.alloc(8169, 7)));
  });

  it("throws on a limit that is not a positive whole number, rather than dropping the bound", () => {
    // NaN is what an unset config value turns into, and it would turn both bounds off.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
      expect(() => gunzipPreparedTransaction(payload, { maxCompressedBytes: bad })).toThrow(RangeError);
      expect(() => gunzipPreparedTransaction(payload, { maxDecompressedBytes: bad })).toThrow(RangeError);
    }
  });
});
