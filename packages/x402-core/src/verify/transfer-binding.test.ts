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
    extra: { assetTransferMethod: "transfer-factory", synchronizerId: "global-domain::1220sync", executeBeforeSeconds: 120, instrumentId: { id: "Amulet", admin: "DSO::1220be58c29e" } },
    payTo: "merchant::1220dead",
    resource: "/api/resource",
    maxTimeoutSeconds: 60,
  };
  const ok: DecodedTransfer = {
    sender: PAYER,
    receiver: "merchant::1220dead",
    amount: "0.01",
    instrumentId: { id: "Amulet", admin: "DSO::1220be58c29e" },
    // Canton signs the PHYSICAL id, so the honest case is the quoted logical
    // one plus a participant-chosen `::<version>-<serial>`.
    synchronizerId: "global-domain::1220sync::35-2",
  };

  it("accepts a transfer that pays exactly the quoted amount", () => {
    expect(findTransferMismatch(ok, requirements, PAYER)).toBeNull();
    expect(findTransferMismatch({ ...ok, amount: "0.0100" }, requirements, PAYER)).toBeNull();
  });

  it("accepts the PHYSICAL synchronizer id the participant signs", () => {
    // `prepare` takes the LOGICAL id and 400s on the physical one, yet the
    // bytes it returns carry the physical form. Exact equality would refuse
    // every honest payment.
    const quoted = requirements.extra.synchronizerId;
    for (const signed of [quoted, `${quoted}::35-2`, `${quoted}::1-1`]) {
      expect(findTransferMismatch({ ...ok, synchronizerId: signed }, requirements, PAYER)).toBeNull();
    }
  });

  it("refuses any other synchronizer, and a missing one", () => {
    // The suffix is the only latitude: the `1220…` is the domain's namespace
    // fingerprint, so `quoted::<n>-<m>` is provably the same domain. Anything
    // else is a different one, or text pretending to be a suffix.
    const quoted = requirements.extra.synchronizerId;
    const bad = [
      undefined,
      "",
      "global-domain::1220other",
      "other-domain::1220sync",
      `${quoted}::35`, // not two runs
      `${quoted}::35-2-1`, // three
      `${quoted}::a-2`, // not decimal
      `${quoted}::35-2x`,
      `${quoted}-35-2`, // no `::`
      `${quoted}::35-2::evil`,
      `${quoted}suffix`,
    ];
    for (const synchronizerId of bad) {
      expect(findTransferMismatch({ ...ok, synchronizerId }, requirements, PAYER)).toBe("synchronizer");
    }
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

  it("rejects a malformed transfer amount rather than reading it as zero", () => {
    for (const bad of ["abc", "-1", "1e3", "0.30000000000", ""]) {
      expect(findTransferMismatch({ ...ok, amount: bad }, requirements, PAYER)).toBe("amount");
    }
  });

  it("rejects a quote that is not in atomic units", () => {
    // "0.01" is a valid ledger Decimal but not a valid quote. Reading it as a
    // quote would compare 1e8 atomic against 0.01 and never match.
    const decimalQuote = { ...requirements, amount: "0.01" };
    expect(findTransferMismatch(ok, decimalQuote, PAYER)).toBe("amount");
  });

  it("checks sender against the payload payer, not the transfer's own claim", () => {
    // Even a well-formed transfer must originate from the authenticated payer.
    expect(findTransferMismatch(ok, requirements, "someoneelse::1220")).toBe("sender");
  });
});
