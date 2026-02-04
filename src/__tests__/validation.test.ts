import { describe, it, expect } from "vitest";
import {
  isValidPartyId,
  isValidAmount,
  isValidResourceId,
} from "../canton/validation.js";

describe("isValidPartyId", () => {
  it("accepts valid party ID", () => {
    expect(
      isValidPartyId(
        "alice::12201234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      ),
    ).toBe(true);
  });

  it("rejects missing :: separator", () => {
    expect(isValidPartyId("alice1234567890abcdef")).toBe(false);
  });

  it("rejects wrong fingerprint prefix", () => {
    expect(
      isValidPartyId(
        "alice::99991234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      ),
    ).toBe(false);
  });

  it("rejects short hex", () => {
    expect(isValidPartyId("alice::1220abcd")).toBe(false);
  });

  it("rejects uppercase hex", () => {
    expect(
      isValidPartyId(
        "alice::1220ABCDEF1234567890abcdef1234567890abcdef1234567890abcdef12345678",
      ),
    ).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidPartyId("")).toBe(false);
  });

  it("rejects empty alias", () => {
    expect(
      isValidPartyId(
        "::12201234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      ),
    ).toBe(false);
  });
});

describe("isValidAmount", () => {
  it("accepts positive amount", () => {
    expect(isValidAmount("1.50")).toBe(true);
  });

  it("rejects zero", () => {
    expect(isValidAmount("0")).toBe(false);
  });

  it("rejects negative", () => {
    expect(isValidAmount("-1.0")).toBe(false);
  });

  it("rejects non-numeric", () => {
    expect(isValidAmount("abc")).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(isValidAmount("Infinity")).toBe(false);
  });

  it("enforces max", () => {
    expect(isValidAmount("100.00", { max: 50 })).toBe(false);
    expect(isValidAmount("49.99", { max: 50 })).toBe(true);
  });

  it("rejects empty", () => {
    expect(isValidAmount("")).toBe(false);
  });
});

describe("isValidResourceId", () => {
  it("accepts URL", () => {
    expect(isValidResourceId("https://example.com/api/v1/resource")).toBe(true);
  });

  it("rejects empty", () => {
    expect(isValidResourceId("")).toBe(false);
  });

  it("rejects control characters", () => {
    expect(isValidResourceId("test\x00resource")).toBe(false);
  });

  it("rejects string over 2048 chars", () => {
    expect(isValidResourceId("a".repeat(2049))).toBe(false);
    expect(isValidResourceId("a".repeat(2048))).toBe(true);
  });
});
