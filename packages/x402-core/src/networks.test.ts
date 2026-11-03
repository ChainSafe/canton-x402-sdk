import { describe, it, expect } from "vitest";
import {
  DEVNET_NETWORK,
  LOCALNET_NETWORK,
  DEVNET_SYNCHRONIZER_ID,
  DEVNET_DSO_PARTY,
  MAINNET_NETWORK,
  MAINNET_SYNCHRONIZER_ID,
  MAINNET_DSO_PARTY,
  TESTNET_NETWORK,
  amuletAsset,
} from "./networks";

describe("network ids", () => {
  it("are the three names the registered Canton scheme spec fixes", () => {
    expect(MAINNET_NETWORK).toBe("canton:mainnet");
    expect(TESTNET_NETWORK).toBe("canton:testnet");
    expect(DEVNET_NETWORK).toBe("canton:devnet");
  });

  it("give LocalNet its own id rather than borrowing DevNet's", () => {
    // The spec's table is not a closed set (Rule 1: whatever the facilitator is
    // configured for), and sharing canton:devnet would leave a local and a real
    // DevNet facilitator indistinguishable on the wire.
    expect(LOCALNET_NETWORK).toBe("canton:localnet");
    expect(LOCALNET_NETWORK).not.toBe(DEVNET_NETWORK);
  });

  it("carry no synchronizer fingerprint", () => {
    for (const id of [MAINNET_NETWORK, TESTNET_NETWORK, DEVNET_NETWORK, LOCALNET_NETWORK]) {
      expect(id).not.toMatch(/1220/);
    }
  });
});

describe("synchronizer identity", () => {
  it("devnet synchronizer id and DSO share the fingerprint", () => {
    const fp = "1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a";
    expect(DEVNET_SYNCHRONIZER_ID).toBe(`global-domain::${fp}`);
    expect(DEVNET_DSO_PARTY).toBe(`DSO::${fp}`);
  });

  it("mainnet synchronizer id and DSO share the fingerprint", () => {
    const fp = "1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";
    expect(MAINNET_SYNCHRONIZER_ID).toBe(`global-domain::${fp}`);
    expect(MAINNET_DSO_PARTY).toBe(`DSO::${fp}`);
  });

  it("is not derivable from the network id, and not meant to be", () => {
    expect(DEVNET_SYNCHRONIZER_ID).not.toContain(DEVNET_NETWORK);
    expect(MAINNET_SYNCHRONIZER_ID).not.toContain(MAINNET_NETWORK);
  });

  it("amuletAsset builds the Amulet instrument for a DSO admin", () => {
    expect(amuletAsset(DEVNET_DSO_PARTY)).toEqual({
      instrumentId: { id: "Amulet", admin: DEVNET_DSO_PARTY },
    });
  });
});
