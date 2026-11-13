import { describe, it, expect } from "vitest";
import { atomicToLedger, ledgerToAtomic, WIRE_DECIMALS } from "./common";
import { findTransferMismatch } from "./canton-exact";
import type { DecodedTransfer } from "./prepared-tx";
import type { CantonPaymentRequirements } from "../types/requirements";

const CC = WIRE_DECIMALS;

describe("atomic ↔ ledger conversion", () => {
  it("converts a ledger Decimal to atomic units", () => {
    expect(ledgerToAtomic("1", CC)).toBe(10_000_000_000n);
    expect(ledgerToAtomic("0.05", CC)).toBe(500_000_000n);
    expect(ledgerToAtomic("0.0000000001", CC)).toBe(1n); // one atomic unit
    expect(ledgerToAtomic("0", CC)).toBe(0n);
  });

  it("treats trailing zeros as the same amount", () => {
    expect(ledgerToAtomic("0.30", CC)).toBe(ledgerToAtomic("0.3", CC));
    expect(ledgerToAtomic("1.0000000000", CC)).toBe(ledgerToAtomic("1", CC));
  });

  it("round-trips", () => {
    for (const atomic of ["0", "1", "500000000", "10000000000", "123456789012345"]) {
      expect(ledgerToAtomic(atomicToLedger(atomic, CC) as string, CC)?.toString()).toBe(atomic);
    }
  });

  it("trims trailing zeros going back to Decimal", () => {
    expect(atomicToLedger("10000000000", CC)).toBe("1");
    expect(atomicToLedger("500000000", CC)).toBe("0.05");
    expect(atomicToLedger("1", CC)).toBe("0.0000000001");
    expect(atomicToLedger("0", CC)).toBe("0");
  });

  it("refuses more precision than the instrument has", () => {
    // Six-place instrument, seven-place amount: converting would silently drop
    // a digit, so it is refused instead.
    expect(ledgerToAtomic("1.1234567", 6)).toBeNull();
    expect(ledgerToAtomic("1.123456", 6)).toBe(1_123_456n);
  });

  it("uses one scale for every instrument on the wire", () => {
    // USDC is six decimals on EVM and ten here: the unit follows the Daml
    // Decimal representation, not the token's native denomination.
    expect(WIRE_DECIMALS).toBe(10);
    expect(ledgerToAtomic("1", WIRE_DECIMALS)).toBe(10_000_000_000n);
  });

  it("scales by the decimals it is given", () => {
    expect(ledgerToAtomic("1", 6)).toBe(1_000_000n);
    expect(ledgerToAtomic("1", 10)).toBe(10_000_000_000n);
    expect(atomicToLedger("1000000", 6)).toBe("1");
    expect(atomicToLedger("1000000", 10)).toBe("0.0001");
  });

  it("returns null rather than a wrong number on malformed input", () => {
    // Never throw and never coerce — a bad value that parsed as 0 would read as
    // a free payment.
    for (const bad of ["abc", "-1", "1e3", " 5 ", "0.30000000000", ""]) {
      expect(ledgerToAtomic(bad, CC)).toBeNull();
    }
    for (const bad of ["abc", "-1", "1.5", "1e3", ""]) {
      expect(atomicToLedger(bad, CC)).toBeNull();
    }
  });
});

describe("findTransferMismatch", () => {
  const PAYER = "alice::1220beef";
  const requirements: CantonPaymentRequirements = {
    scheme: "exact",
    network: "canton:devnet",
    amount: "100000000",
    asset: "CC",
    extra: { assetTransferMethod: "transfer-factory", synchronizerId: "global-domain::1220be58c29e", feePayer: "x402-facilitator::1220fee", executeBeforeSeconds: 120, instrumentId: { id: "Amulet", admin: "DSO::1220be58c29e" } },
    payTo: "merchant::1220dead",
    maxTimeoutSeconds: 60,
  };
  const ok: DecodedTransfer = {
  synchronizerId: "global-domain::1220be58c29e",
    sender: PAYER,
    receiver: "merchant::1220dead",
    amount: "0.01",
    instrumentId: { id: "Amulet", admin: "DSO::1220be58c29e" },
  };

  it("accepts a transfer that pays exactly the quoted amount", () => {
    expect(findTransferMismatch(ok, requirements)).toBeNull();
    expect(findTransferMismatch({ ...ok, amount: "0.0100" }, requirements)).toBeNull();
  });

  it("rejects an overpayment", () => {
    // Previously allowed. Rule 4: the transfer amount MUST EQUAL the quote.
    expect(findTransferMismatch({ ...ok, amount: "0.02" }, requirements)).toBe("amount");
  });

  it("rejects wrong receiver / instrument / amount", () => {
    expect(findTransferMismatch({ ...ok, receiver: "mallory::1220bad" }, requirements)).toBe("receiver");
    expect(findTransferMismatch({ ...ok, instrumentId: { id: "USDC", admin: "DSO::1220be58c29e" } }, requirements)).toBe("instrument");
    expect(findTransferMismatch({ ...ok, instrumentId: { id: "Amulet", admin: "evil::1220" } }, requirements)).toBe("instrument");
    expect(findTransferMismatch({ ...ok, amount: "0.009" }, requirements)).toBe("amount");
  });

  it("rejects a malformed transfer amount rather than reading it as zero", () => {
    for (const bad of ["abc", "-1", "1e3", "0.30000000000", ""]) {
      expect(findTransferMismatch({ ...ok, amount: bad }, requirements)).toBe("amount");
    }
  });

  it("rejects a quote that is not in atomic units", () => {
    // "0.01" is a valid ledger Decimal but not a valid quote. Reading it as a
    // quote would compare 1e8 atomic against 0.01 and never match.
    const decimalQuote = { ...requirements, amount: "0.01" };
    expect(findTransferMismatch(ok, decimalQuote)).toBe("amount");
  });

  it("has no sender to check: the sender is the payer (spec Rule 8)", () => {
    // The payload names no payer, so any sender is accepted here; the ledger
    // checks at execute that the sender signed.
    expect(findTransferMismatch({ ...ok, sender: "someoneelse::1220" }, requirements)).toBeNull();
  });
});

describe("the synchronizer the payer signed", () => {
  const quoted = "global-domain::1220be58c29e";
  const req = (over = {}) =>
    ({
      scheme: "exact",
      network: "canton:devnet",
      amount: "100000000",
      asset: "CC",
      payTo: "merchant::1220dead",
      maxTimeoutSeconds: 60,
      extra: {
        assetTransferMethod: "transfer-factory",
        synchronizerId: quoted,
        executeBeforeSeconds: 120,
        instrumentId: { id: "Amulet", admin: "DSO::1220dso" },
        ...over,
      },
    }) as unknown as CantonPaymentRequirements;
  const transfer = (synchronizerId?: string): DecodedTransfer => ({
    sender: "alice::1220beef",
    receiver: "merchant::1220dead",
    amount: "0.01",
    instrumentId: { id: "Amulet", admin: "DSO::1220dso" },
    ...(synchronizerId === undefined ? {} : { synchronizerId }),
  });

  it("takes the logical id exactly", () => {
    expect(findTransferMismatch(transfer(quoted), req())).toBeNull();
  });

  it("takes the PHYSICAL id too, which newer Canton signs", () => {
    // `prepare` takes the logical id and refuses the physical one, yet newer
    // releases sign the physical form into the bytes it returns. Exact
    // equality would refuse every honest payment from one of those. The case
    // above covers the logical form, which is what LocalNet signs.
    for (const suffix of ["35-2", "0-0", "100-27"]) {
      expect(findTransferMismatch(transfer(`${quoted}::${suffix}`), req())).toBeNull();
    }
  });

  it("refuses anything else after the logical id", () => {
    // Not "": that is the logical id exactly, which the case above accepts.
    for (const tail of ["::", "::35", "::35-2-1", "::v35-2", "::35-2x", "-35-2", "x"]) {
      expect(findTransferMismatch(transfer(`${quoted}${tail}`), req())).toBe("synchronizer");
    }
  });

  it("refuses another domain, however similar", () => {
    for (const other of [
      "global-domain::1220be58c29f",
      "other-domain::1220be58c29e",
      "global-domain::1220be58c29e-extra",
    ]) {
      expect(findTransferMismatch(transfer(other), req())).toBe("synchronizer");
    }
  });

  it("counts an unsigned synchronizer as a mismatch", () => {
    // A transfer naming no domain is not one that named the merchant's.
    expect(findTransferMismatch(transfer(undefined), req())).toBe("synchronizer");
  });
});
