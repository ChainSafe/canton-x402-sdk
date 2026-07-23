import { describe, it, expect } from "vitest";
import { amountGte } from "./common";
import { findTransferMismatch } from "./exact-canton";
import type { DecodedTransfer } from "./prepared-tx";
import type { CantonPaymentRequirements } from "../types/requirements";

describe("amountGte — decimal-safe >=", () => {
  it("compares integers and decimals without float error", () => {
    expect(amountGte("4000", "4000")).toBe(true); // equal
    expect(amountGte("4000.0000000001", "4000")).toBe(true); // over
    expect(amountGte("3999.9999999999", "4000")).toBe(false); // under
    expect(amountGte("0.30", "0.3")).toBe(true); // trailing-zero equal
    expect(amountGte("0.1", "0.10")).toBe(true);
    // >10dp is not a valid amount, so the compare returns false regardless.
    expect(amountGte("0.3", "0.30000000000")).toBe(false);
  });

  it("returns false when either side is not a valid amount", () => {
    expect(amountGte("abc", "1")).toBe(false);
    expect(amountGte("1", "-1")).toBe(false);
    expect(amountGte("1", "1e3")).toBe(false);
    expect(amountGte("Infinity", "0")).toBe(false);
  });
});

describe("findTransferMismatch", () => {
  const PAYER = "alice::1220beef";
  const requirements: CantonPaymentRequirements = {
    scheme: "exact-canton",
    network: "canton:1220be58c29e",
    maxAmountRequired: "0.01",
    asset: { instrumentId: { id: "Amulet", admin: "DSO::1220be58c29e" } },
    payTo: "merchant::1220dead",
    resource: "/api/resource",
    nonce: "n-1",
    validBefore: "2999-01-01T00:00:00.000Z",
  };
  const ok: DecodedTransfer = {
    sender: PAYER,
    receiver: "merchant::1220dead",
    amount: "0.01",
    instrumentId: { id: "Amulet", admin: "DSO::1220be58c29e" },
  };

  it("accepts a faithful transfer (exact and overpaid)", () => {
    expect(findTransferMismatch(ok, requirements, PAYER)).toBeNull();
    expect(findTransferMismatch({ ...ok, amount: "0.02" }, requirements, PAYER)).toBeNull();
  });

  it("rejects wrong sender / receiver / instrument / underpayment", () => {
    expect(findTransferMismatch({ ...ok, sender: "mallory::1220bad" }, requirements, PAYER)).toBe("sender");
    expect(findTransferMismatch({ ...ok, receiver: "mallory::1220bad" }, requirements, PAYER)).toBe("receiver");
    expect(findTransferMismatch({ ...ok, instrumentId: { id: "USDC", admin: "DSO::1220be58c29e" } }, requirements, PAYER)).toBe("instrument");
    expect(findTransferMismatch({ ...ok, instrumentId: { id: "Amulet", admin: "evil::1220" } }, requirements, PAYER)).toBe("instrument");
    expect(findTransferMismatch({ ...ok, amount: "0.009" }, requirements, PAYER)).toBe("amount");
  });

  it("checks sender against the payload payer, not the transfer's own claim", () => {
    // Even a well-formed transfer must originate from the authenticated payer.
    expect(findTransferMismatch(ok, requirements, "someoneelse::1220")).toBe("sender");
  });
});
