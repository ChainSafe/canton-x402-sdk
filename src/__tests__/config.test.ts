import { describe, it, expect } from "vitest";
import { validateConfig, localnetConfig } from "../config.js";
import type { CantonSdkConfig } from "../types.js";

function makeConfig(overrides?: Partial<CantonSdkConfig>): CantonSdkConfig {
  return {
    network: "canton-devnet",
    ledgerApiUrl: "https://ledger.example.com",
    scanProxyUrl: "https://scan.example.com",
    dsoParty: "DSO::1220abcdef",
    auth: {
      type: "oauth2",
      tokenUrl: "https://auth.example.com/token",
      clientId: "test-id",
      clientSecret: "test-secret",
    },
    ...overrides,
  };
}

describe("validateConfig", () => {
  it("accepts valid devnet config", () => {
    expect(() => validateConfig(makeConfig())).not.toThrow();
  });

  it("rejects unsafe shared-secret on non-local network", () => {
    expect(() =>
      validateConfig(
        makeConfig({
          network: "canton-devnet",
          auth: { type: "shared-secret", secret: "unsafe", userId: "test" },
        }),
      ),
    ).toThrow(/not allowed/);
  });

  it("allows unsafe shared-secret on canton-local", () => {
    expect(() =>
      validateConfig(
        makeConfig({
          network: "canton-local",
          ledgerApiUrl: "http://localhost:2975",
          auth: { type: "shared-secret", secret: "unsafe", userId: "test" },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects HTTP OAuth tokenUrl on non-local", () => {
    expect(() =>
      validateConfig(
        makeConfig({
          auth: {
            type: "oauth2",
            tokenUrl: "http://auth.example.com/token",
            clientId: "id",
            clientSecret: "secret",
          },
        }),
      ),
    ).toThrow(/HTTPS/);
  });

  it("rejects HTTP ledgerApiUrl on non-local", () => {
    expect(() =>
      validateConfig(makeConfig({ ledgerApiUrl: "http://ledger.example.com" })),
    ).toThrow(/HTTPS/);
  });

  it("allows HTTP on canton-local", () => {
    expect(() =>
      validateConfig(
        makeConfig({
          network: "canton-local",
          ledgerApiUrl: "http://localhost:2975",
          auth: {
            type: "oauth2",
            tokenUrl: "http://keycloak.localhost/token",
            clientId: "id",
            clientSecret: "secret",
          },
        }),
      ),
    ).not.toThrow();
  });
});

describe("localnetConfig", () => {
  it("returns canton-local config", () => {
    const cfg = localnetConfig({ dsoParty: "DSO::1220test" });
    expect(cfg.network).toBe("canton-local");
    expect(cfg.auth.type).toBe("shared-secret");
  });
});
