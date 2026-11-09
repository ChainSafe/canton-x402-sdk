import { describe, it, expect } from "vitest";
import { DEVNET_NETWORK, LOCALNET_NETWORK, MAINNET_NETWORK } from "@chainsafe/x402-core";
import { localnetConfig, devnetConfig, mainnetConfig } from "./canton-config";

describe("config presets", () => {
  it("localnet takes no arguments at all", () => {
    const c = localnetConfig();
    expect(c.network).toBe(LOCALNET_NETWORK);
    expect(c.network).toBe("canton:localnet");
    expect(c.ledgerClientUrl).toContain("localhost");
    expect(c.auth.issuer).toBe("unsafe-auth");
  });

  it("localnet does not fall back to another network's id", () => {
    // The default is the whole point of the preset: a LocalNet instance has no
    // registered name of its own, and borrowing DevNet's would make a local and
    // a real DevNet facilitator indistinguishable on the wire.
    expect(localnetConfig().network).not.toBe(DEVNET_NETWORK);
    expect(localnetConfig().network).not.toBe(MAINNET_NETWORK);
  });

  it("localnet still accepts an explicit network", () => {
    const c = localnetConfig({ network: "canton:devnet" });
    expect(c.network).toBe("canton:devnet");
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
