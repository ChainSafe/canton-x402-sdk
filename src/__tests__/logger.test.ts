import { describe, it, expect, vi } from "vitest";
import { redactSensitive, JsonLogger, noopLogger } from "../logger.js";

describe("redactSensitive", () => {
  it("redacts known sensitive fields", () => {
    const data = {
      userId: "alice",
      secret: "my-secret",
      clientSecret: "oauth-secret",
      password: "hunter2",
      token: "jwt-token",
      access_token: "bearer-token",
      privateKey: "ed25519-key",
      authorization: "Bearer xyz",
    };

    const result = redactSensitive(data);

    expect(result.userId).toBe("alice");
    expect(result.secret).toBe("[REDACTED]");
    expect(result.clientSecret).toBe("[REDACTED]");
    expect(result.password).toBe("[REDACTED]");
    expect(result.token).toBe("[REDACTED]");
    expect(result.access_token).toBe("[REDACTED]");
    expect(result.privateKey).toBe("[REDACTED]");
    expect(result.authorization).toBe("[REDACTED]");
  });

  it("passes through non-sensitive fields unchanged", () => {
    const data = { name: "test", count: 42, url: "https://example.com" };
    const result = redactSensitive(data);
    expect(result).toEqual(data);
  });

  it("handles empty object", () => {
    expect(redactSensitive({})).toEqual({});
  });
});

describe("JsonLogger", () => {
  it("outputs JSON with correct structure", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new JsonLogger("test-component");

    logger.info("test message", { key: "value" });

    expect(spy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(spy.mock.calls[0][0] as string);
    expect(output.level).toBe("info");
    expect(output.component).toBe("test-component");
    expect(output.msg).toBe("test message");
    expect(output.key).toBe("value");
    expect(output.ts).toBeDefined();

    spy.mockRestore();
  });

  it("redacts sensitive fields in log data", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new JsonLogger();

    logger.warn("auth attempt", { clientSecret: "should-be-hidden", userId: "visible" });

    const output = JSON.parse(spy.mock.calls[0][0] as string);
    expect(output.clientSecret).toBe("[REDACTED]");
    expect(output.userId).toBe("visible");

    spy.mockRestore();
  });

  it("logs all levels", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new JsonLogger();

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(spy).toHaveBeenCalledTimes(4);
    const levels = spy.mock.calls.map(
      (c) => JSON.parse(c[0] as string).level,
    );
    expect(levels).toEqual(["debug", "info", "warn", "error"]);

    spy.mockRestore();
  });
});

describe("noopLogger", () => {
  it("has all required methods", () => {
    expect(typeof noopLogger.debug).toBe("function");
    expect(typeof noopLogger.info).toBe("function");
    expect(typeof noopLogger.warn).toBe("function");
    expect(typeof noopLogger.error).toBe("function");
  });

  it("does not throw when called", () => {
    expect(() => noopLogger.debug("test")).not.toThrow();
    expect(() => noopLogger.info("test", { key: "val" })).not.toThrow();
    expect(() => noopLogger.warn("test")).not.toThrow();
    expect(() => noopLogger.error("test")).not.toThrow();
  });
});
