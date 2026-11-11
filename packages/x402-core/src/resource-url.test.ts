import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

import { hashResourceUrl, resourceUrlMatchesStamp } from "./resource-url";

const URL_A = "https://merchant.example/report";
const URL_B = "https://merchant.example/premium";

describe("hashResourceUrl", () => {
  it("is the lowercase-hex SHA-256 of the exact UTF-8 URL", () => {
    // Spelled out rather than pinned to a literal: the point is that anyone
    // can reproduce it, which is what lets a facilitator check a stamp it did
    // not write.
    expect(hashResourceUrl(URL_A)).toBe(createHash("sha256").update(URL_A, "utf8").digest("hex"));
    expect(hashResourceUrl(URL_A)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is unsalted, so the same URL always gives the same stamp", () => {
    expect(hashResourceUrl(URL_A)).toBe(hashResourceUrl(URL_A));
    expect(hashResourceUrl(URL_A)).not.toBe(hashResourceUrl(URL_B));
  });

  it("hashes the exact string, with no normalisation", () => {
    // A trailing slash, a different case host and a query are different
    // resources as far as the stamp is concerned. A merchant pinning
    // `resource` and a payer stamping it agree because both use the string.
    for (const [a, b] of [
      [URL_A, `${URL_A}/`],
      [URL_A, URL_A.toUpperCase()],
      [URL_A, `${URL_A}?page=2`],
    ]) {
      expect(hashResourceUrl(a)).not.toBe(hashResourceUrl(b));
    }
  });

  it("handles a non-ASCII URL as UTF-8", () => {
    const unicode = "https://merchant.example/caffè";
    expect(hashResourceUrl(unicode)).toBe(
      createHash("sha256").update(unicode, "utf8").digest("hex"),
    );
  });
});

describe("resourceUrlMatchesStamp", () => {
  it("accepts the hashed stamp", () => {
    expect(resourceUrlMatchesStamp(hashResourceUrl(URL_A), URL_A)).toBe(true);
  });

  it("accepts a plaintext stamp, for clients that predate the hashed form", () => {
    // Refusing them would refuse payments that ARE correctly bound; the
    // privacy of the hash is the stamping client's choice, not one a verifier
    // can impose afterwards.
    expect(resourceUrlMatchesStamp(URL_A, URL_A)).toBe(true);
  });

  it("refuses a stamp for another resource, in either form", () => {
    expect(resourceUrlMatchesStamp(hashResourceUrl(URL_B), URL_A)).toBe(false);
    expect(resourceUrlMatchesStamp(URL_B, URL_A)).toBe(false);
  });

  it("refuses a stamp that is neither the URL nor its hash", () => {
    for (const stamp of ["", "not-a-hash", hashResourceUrl(URL_A).toUpperCase()]) {
      expect(resourceUrlMatchesStamp(stamp, URL_A)).toBe(false);
    }
  });
});
