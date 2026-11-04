import { describe, it, expect } from "vitest";
import { amountMatches, atomicToLedger, ledgerToAtomic } from "./common";
import { findTransferMismatch } from "./canton-exact";
import type { DecodedTransfer } from "./prepared-tx";
import type { CantonPaymentRequirements } from "../types/requirements";

describe("atomic ↔ ledger conversion", () => {
  it("converts a ledger Decimal to atomic units", () => {
    expect(ledgerToAtomic("1")).toBe(10_000_000_000n);
    expect(ledgerToAtomic("0.05")).toBe(500_000_000n);
    expect(ledgerToAtomic("0.0000000001")).toBe(1n); // one atomic unit
    expect(ledgerToAtomic("0")).toBe(0n);
  });

  it("treats trailing zeros as the same amount", () => {
    expect(ledgerToAtomic("0.30")).toBe(ledgerToAtomic("0.3"));
    expect(ledgerToAtomic("1.0000000000")).toBe(ledgerToAtomic("1"));
  });

  it("round-trips", () => {
    for (const atomic of ["0", "1", "500000000", "10000000000", "123456789012345"]) {
      expect(ledgerToAtomic(atomicToLedger(atomic) as string)?.toString()).toBe(atomic);
    }
  });

  it("trims trailing zeros going back to Decimal", () => {
    expect(atomicToLedger("10000000000")).toBe("1");
    expect(atomicToLedger("500000000")).toBe("0.05");
    expect(atomicToLedger("1")).toBe("0.0000000001");
    expect(atomicToLedger("0")).toBe("0");
  });

  it("returns null rather than a wrong number on malformed input", () => {
    // Never throw and never coerce — a bad value that parsed as 0 would read as
    // a free payment.
    for (const bad of ["abc", "-1", "1e3", " 5 ", "0.30000000000", ""]) {
      expect(ledgerToAtomic(bad)).toBeNull();
    }
    for (const bad of ["abc", "-1", "1.5", "1e3", ""]) {
      expect(atomicToLedger(bad)).toBeNull();
    }
  });
});

describe("amountMatches — EQUAL, across the unit boundary", () => {
  it("matches a ledger Decimal against the quoted atomic amount", () => {
    expect(amountMatches("0.05", "500000000")).toBe(true);
    expect(amountMatches("0.050", "500000000")).toBe(true); // trailing zero
    expect(amountMatches("1", "10000000000")).toBe(true);
  });

  it("refuses an overpayment — `exact` means exact (Rule 4)", () => {
    // The old behaviour accepted this. A payer who signs for more than was
    // quoted loses the difference with no refund path.
    expect(amountMatches("0.06", "500000000")).toBe(false);
    expect(amountMatches("0.0500000001", "500000000")).toBe(false);
  });

  it("refuses an underpayment", () => {
    expect(amountMatches("0.04", "500000000")).toBe(false);
    expect(amountMatches("0.0499999999", "500000000")).toBe(false);
  });

  it("refuses a malformed amount on either side", () => {
    expect(amountMatches("abc", "500000000")).toBe(false);
    expect(amountMatches("0.05", "abc")).toBe(false);
    expect(amountMatches("0.05", "0.05")).toBe(false); // a Decimal where atomic was expected
    expect(amountMatches("Infinity", "0")).toBe(false);
  });
});

describe("findTransferMismatch", () => {
  const PAYER = "alice::1220beef";
  const requirements: CantonPaymentRequirements = {
    scheme: "exact",
    network: "canton:devnet",
    amount: "100000000",
    asset: "CC",
    extra: { instrumentId: { id: "Amulet", admin: "DSO::1220be58c29e" } },
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

  it("accepts a transfer that pays exactly the quoted amount", () => {
    expect(findTransferMismatch(ok, requirements, PAYER)).toBeNull();
    expect(findTransferMismatch({ ...ok, amount: "0.0100" }, requirements, PAYER)).toBeNull();
  });

  it("rejects an overpayment", () => {
    // Previously allowed. Rule 4: the transfer amount MUST EQUAL the quote.
    expect(findTransferMismatch({ ...ok, amount: "0.02" }, requirements, PAYER)).toBe("amount");
  });

  it("rejects wrong sender / receiver / instrument / amount", () => {
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
