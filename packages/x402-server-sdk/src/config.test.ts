import { describe, it, expect } from "vitest";
import { DEVNET_NETWORK, MAINNET_NETWORK } from "@chainsafe/x402-core";
import { localnetConfig, devnetConfig, mainnetConfig } from "./config";

describe("config presets", () => {
  it("localnet fills localhost URLs + unsafe auth, takes the per-instance network", () => {
    const c = localnetConfig({ network: "canton:localfp" });
    expect(c.network).toBe("canton:localfp");
    expect(c.ledgerClientUrl).toContain("localhost");
    expect(c.registryUrl).toContain("localhost");
    expect(c.auth.issuer).toBe("unsafe-auth");
  });

  it("devnet fills the network id from core, takes deployment URLs", () => {
    const c = devnetConfig({ ledgerClientUrl: "https://ledger", registryUrl: "https://registry" });
    expect(c.network).toBe(DEVNET_NETWORK);
    expect(c.ledgerClientUrl).toBe("https://ledger");
    expect(c.registryUrl).toBe("https://registry");
  });

  it("mainnet fills the network id from core", () => {
    const c = mainnetConfig({ ledgerClientUrl: "https://ledger", registryUrl: "https://registry" });
    expect(c.network).toBe(MAINNET_NETWORK);
  });

  it("explicit overrides win over defaults", () => {
    const c = devnetConfig({ ledgerClientUrl: "https://l", registryUrl: "https://r", network: "canton:custom" });
    expect(c.network).toBe("canton:custom");
  });
});
