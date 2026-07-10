import { describe, it, expect } from "vitest";
import { VERSION } from "./index";

describe("x402-core toolchain", () => {
  it("exposes the version placeholder", () => {
    expect(VERSION).toBe("0.0.1");
  });
});
