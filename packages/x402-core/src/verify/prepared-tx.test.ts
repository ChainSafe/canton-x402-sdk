import { describe, it, expect } from "vitest";
import { decodePreparedTransaction, type DecodedTransfer } from "./prepared-tx";
import { encodePreparedTransaction } from "./prepared-tx.fixtures";

const TRANSFER: DecodedTransfer = {
  sender: "alice::1220beef",
  receiver: "merchant::1220dead",
  amount: "0.01",
  instrumentId: { id: "Amulet", admin: "DSO::1220dso" },
};

describe("decodePreparedTransaction", () => {
  it("round-trips a labeled record encoding", () => {
    const blob = encodePreparedTransaction(TRANSFER);
    expect(decodePreparedTransaction(blob)).toEqual(TRANSFER);
  });

  it("round-trips a positional (unlabeled) record encoding", () => {
    // Canton hashes prepared transactions, so real blobs may omit labels and
    // rely on field order — the decoder must handle that too.
    const blob = encodePreparedTransaction(TRANSFER, { positional: true });
    expect(decodePreparedTransaction(blob)).toEqual(TRANSFER);
  });

  it("preserves an amount with decimals and a distinct instrument", () => {
    const t: DecodedTransfer = {
      sender: "p::1220a",
      receiver: "m::1220b",
      amount: "1234.5678",
      instrumentId: { id: "USDC", admin: "issuer::1220c" },
    };
    expect(decodePreparedTransaction(encodePreparedTransaction(t))).toEqual(t);
    expect(decodePreparedTransaction(encodePreparedTransaction(t, { positional: true }))).toEqual(t);
  });

  it("returns null when the exercise is not a TransferFactory_Transfer", () => {
    const blob = encodePreparedTransaction(TRANSFER, { choiceId: "SomeOtherChoice" });
    expect(decodePreparedTransaction(blob)).toBeNull();
  });

  it("returns null on garbage / non-protobuf input (never throws)", () => {
    expect(decodePreparedTransaction("not-base64!!")).toBeNull();
    expect(decodePreparedTransaction("")).toBeNull();
    expect(decodePreparedTransaction(btoa("plain text, not a prepared tx"))).toBeNull();
  });
});
