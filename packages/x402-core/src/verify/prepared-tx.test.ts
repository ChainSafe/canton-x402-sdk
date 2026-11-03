import { describe, it, expect } from "vitest";
import { decodePreparedTransaction, type DecodedTransfer } from "./prepared-tx";
import {
  encodeChoiceArgument,
  encodePreparedTransaction,
  wrap,
  type EncodeOptions,
} from "./prepared-tx.fixtures";

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

describe("decodePreparedTransaction on a non-canonical encoding", () => {
  // Protobuf merges a repeated singular field and keeps the last member of a
  // oneof, so a full decoder need not read the transfer a first-match walk
  // would. Canton never encodes these. Each case decodes to a transfer when
  // the canonical-encoding check is removed.
  const empty = new Uint8Array();
  const utf8 = (s: string) => new TextEncoder().encode(s);

  const cases: [string, EncodeOptions][] = [
    ["a node that is also a create", { extra: { node: wrap(1, empty) } }],
    ["a node whose v1 body is written twice", { extra: { damlNode: wrap(1000, wrap(1, empty)) } }],
    ["a transaction written twice", { extra: { prepared: wrap(1, empty) } }],
    [
      "an exercise whose choice id is written twice",
      { choiceId: "SomeOtherChoice", extra: { exercise: wrap(9, utf8("TransferFactory_Transfer")) } },
    ],
    [
      "an exercise whose chosen value is written twice",
      { extra: { exercise: wrap(10, encodeChoiceArgument(TRANSFER)) } },
    ],
    ["a value with two members", { extra: { receiver: wrap(8, utf8("someone::1220")) } }],
    [
      "a record field whose value is written twice",
      { extra: { receiverField: wrap(2, wrap(7, utf8("someone::1220"))) } },
    ],
  ];

  it.each(cases)("returns null for %s", (_, opts) => {
    expect(decodePreparedTransaction(encodePreparedTransaction(TRANSFER, opts))).toBeNull();
  });

  it("still decodes when the other fields appear once each", () => {
    // DamlTransaction.Node.node_id and Exercise.template_id
    const blob = encodePreparedTransaction(TRANSFER, {
      extra: { damlNode: wrap(1, utf8("0")), exercise: wrap(4, empty) },
    });
    expect(decodePreparedTransaction(blob)).toEqual(TRANSFER);
  });
});
