import { describe, it, expect } from "vitest";
import {
  DEVNET_NETWORK,
  DEVNET_SYNCHRONIZER_ID,
  DEVNET_DSO_PARTY,
  MAINNET_NETWORK,
  MAINNET_SYNCHRONIZER_ID,
  MAINNET_DSO_PARTY,
  amuletAsset,
} from "./networks";

describe("networks", () => {
  it("devnet network, synchronizer id, and DSO share the fingerprint", () => {
    const fp = "1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a";
    expect(DEVNET_NETWORK).toBe(`canton:${fp}`);
    expect(DEVNET_SYNCHRONIZER_ID).toBe(`global-domain::${fp}`);
    expect(DEVNET_DSO_PARTY).toBe(`DSO::${fp}`);
  });

  it("mainnet network, synchronizer id, and DSO share the fingerprint", () => {
    const fp = "1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";
    expect(MAINNET_NETWORK).toBe(`canton:${fp}`);
    expect(MAINNET_SYNCHRONIZER_ID).toBe(`global-domain::${fp}`);
    expect(MAINNET_DSO_PARTY).toBe(`DSO::${fp}`);
  });

  it("amuletAsset builds the Amulet instrument for a DSO admin", () => {
    expect(amuletAsset(DEVNET_DSO_PARTY)).toEqual({
      instrumentId: { id: "Amulet", admin: DEVNET_DSO_PARTY },
    });
  });
});
