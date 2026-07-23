import { describe, it, expect } from "vitest";
import { DEVNET_NETWORK, MAINNET_NETWORK } from "@chainsafe/x402-core";
import { localnetConfig, devnetConfig, mainnetConfig } from "./canton-config";

describe("config presets", () => {
  it("localnet fills the localhost ledger URL + unsafe auth, takes the per-instance network", () => {
    const c = localnetConfig({ network: "canton:localfp" });
    expect(c.network).toBe("canton:localfp");
    expect(c.ledgerClientUrl).toContain("localhost");
    expect(c.auth.issuer).toBe("unsafe-auth");
  });

  it("devnet fills the network id from core, takes the ledger URL", () => {
    const c = devnetConfig({ ledgerClientUrl: "https://ledger" });
    expect(c.network).toBe(DEVNET_NETWORK);
    expect(c.ledgerClientUrl).toBe("https://ledger");
  });

  it("mainnet fills the network id from core", () => {
    const c = mainnetConfig({ ledgerClientUrl: "https://ledger" });
    expect(c.network).toBe(MAINNET_NETWORK);
  });

  it("explicit overrides win over defaults", () => {
    const c = devnetConfig({ ledgerClientUrl: "https://l", network: "canton:custom" });
    expect(c.network).toBe("canton:custom");
  });
});
