import { describe, it, expect } from "vitest";
import { decodePreparedTransaction, type DecodedTransfer } from "./prepared-tx";
import {
  encodeChoiceArgument,
  encodeNode,
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
const OTHER: DecodedTransfer = { ...TRANSFER, receiver: "someone::1220", amount: "9" };

const empty = new Uint8Array();
const utf8 = (s: string) => new TextEncoder().encode(s);
/** A v1 `Node` body: a TransferFactory_Transfer exercise for `t`. */
const transferBody = (t: DecodedTransfer) =>
  wrap(3, concat(wrap(9, utf8("TransferFactory_Transfer")), wrap(10, encodeChoiceArgument(t))));

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
  const cases: [string, EncodeOptions][] = [
    ["a node that is also a create", { extra: { node: wrap(1, empty) } }],
    ["a node whose v1 body is written twice", { extra: { damlNode: wrap(1000, transferBody(OTHER)) } }],
    ["a transaction written twice", { extra: { prepared: wrap(1, empty) } }],
    [
      "an exercise whose choice id is written twice",
      { choiceId: "SomeOtherChoice", extra: { exercise: wrap(9, utf8("TransferFactory_Transfer")) } },
    ],
    [
      "an exercise whose chosen value is written twice",
      { extra: { exercise: wrap(10, encodeChoiceArgument(TRANSFER)) } },
    ],
    ["a node that is also a query_by_key", { extra: { node: wrap(5, empty) } }],
    ["a node with a field other than node_id and v1", { extra: { damlNode: wrap(1001, empty) } }],
    ["a value with two members", { extra: { receiver: wrap(8, utf8("someone::1220")) } }],
    ["a value with a member this decoder does not know", { extra: { receiver: wrap(17, empty) } }],
    [
      "a record field whose value is written twice",
      { extra: { receiverField: wrap(2, wrap(7, utf8("someone::1220"))) } },
    ],
  ];

  it.each(cases)("returns null for %s", (_, opts) => {
    expect(decodePreparedTransaction(encodePreparedTransaction(TRANSFER, opts))).toBeNull();
  });

  // protobufjs alone reads each of these differently from protobuf-java.
  const wireCases: [string, number[]][] = [
    // A 6-byte tag: protobufjs skips a fixed 10 bytes, Java reads 6.
    ["a tag written as a 6-byte varint", [0xa0, 0x86, 0x80, 0x80, 0x80, 0x00, 0, 0, 0, 0, 0]],
    // Field 100, then a 6-byte length 0: same split on a length.
    ["a length written as a 6-byte varint", [0xa2, 0x06, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00, 0, 0, 0, 0]],
    // Field 100 as a group: protobufjs ends it at any end-group tag.
    ["a group", [0xa3, 0x06, 0xa4, 0x06]],
  ];

  it.each(wireCases)("returns null for %s", (_, bytes) => {
    const blob = encodePreparedTransaction(TRANSFER, { extra: { exercise: Uint8Array.from(bytes) } });
    expect(decodePreparedTransaction(blob)).toBeNull();
  });

  it("returns null for a string that is not valid UTF-8", () => {
    // protobufjs drops the stray 0x80 and reads the transfer choice.
    const choice = concat(concat(utf8("Transfer"), Uint8Array.of(0x80)), utf8("Factory_Transfer"));
    const exercise = concat(wrap(9, choice), wrap(10, encodeChoiceArgument(TRANSFER)));
    const txn = concat(wrap(2, utf8("0")), wrap(3, encodeNode("0", wrap(3, exercise))));
    expect(decodePreparedTransaction(btoa(String.fromCharCode(...wrap(1, txn))))).toBeNull();
  });

  it("still decodes when the other fields appear once each", () => {
    // PreparedTransaction.metadata and Exercise.template_id
    const blob = encodePreparedTransaction(TRANSFER, {
      extra: { prepared: wrap(2, empty), exercise: wrap(4, empty) },
    });
    expect(decodePreparedTransaction(blob)).toEqual(TRANSFER);
  });
});

describe("decodePreparedTransaction reads only the node tree under the roots", () => {
  const create = wrap(1, empty); // v1 Node{1: create}
  /** A repeated string `field`, once per value. */
  const repeated = (field: number, values: string[]) =>
    values.reduce<Uint8Array>((acc, v) => concat(acc, wrap(field, utf8(v))), empty);
  const rollbackOf = (...children: string[]) => wrap(4, repeated(1, children)); // Rollback{1: children}
  const parentOf = (...children: string[]) =>
    wrap(3, concat(wrap(9, utf8("SomeOtherChoice")), repeated(12, children))); // Exercise{12: children}

  it("decodes a transfer nested under another exercise", () => {
    const blob = encodePreparedTransaction(TRANSFER, {
      nodeId: "1",
      roots: ["0"],
      nodes: [encodeNode("0", parentOf("1"))],
    });
    expect(decodePreparedTransaction(blob)).toEqual(TRANSFER);
  });

  it("decodes a transfer next to a rollback node", () => {
    const blob = encodePreparedTransaction(TRANSFER, {
      roots: ["0", "1"],
      nodes: [encodeNode("1", rollbackOf("2")), encodeNode("2", create)],
    });
    expect(decodePreparedTransaction(blob)).toEqual(TRANSFER);
  });

  const cases: [string, EncodeOptions][] = [
    // Canton keeps the last node of a repeated id, so it would not run the transfer.
    ["two nodes with the same id", { nodes: [encodeNode("0", create)] }],
    ["two transfers with the same id", { nodes: [encodeNode("0", transferBody(OTHER))] }],
    ["a transfer node the roots cannot reach", { nodeId: "1", roots: ["0"], nodes: [encodeNode("0", create)] }],
    // Canton refuses a transaction with a node outside the tree.
    ["another node the roots cannot reach", { nodes: [encodeNode("1", create)] }],
    ["a root that names no node", { roots: ["0", "9"] }],
    ["a root that names no node, next to an unreachable node", { roots: ["0", "9"], nodes: [encodeNode("1", create)] }],
    ["a node referenced twice", { roots: ["0", "0"] }],
    // Canton parses ids as integers, so "00" and "٠" are node 0 to it.
    ...["00", "+0", "٠"].map((alias): [string, EncodeOptions] => [
      `a child id "${alias}" that Canton reads as the transfer node's`,
      { extra: { exercise: wrap(12, utf8(alias)) }, nodes: [encodeNode(alias, create)] },
    ]),
    ["a node id that is not an integer", { nodeId: "a", roots: ["a"] }],
    ["a node with an empty v1 body", { roots: ["0", "1"], nodes: [encodeNode("1", empty)] }],
    [
      "a transfer under an exercise under a rollback node",
      { nodeId: "1", roots: ["0"], nodes: [encodeNode("0", rollbackOf("2")), encodeNode("2", parentOf("1"))] },
    ],
    ["a transfer under a rollback node", { nodeId: "1", roots: ["0"], nodes: [encodeNode("0", rollbackOf("1"))] }],
  ];

  it.each(cases)("returns null for %s", (_, opts) => {
    expect(decodePreparedTransaction(encodePreparedTransaction(TRANSFER, opts))).toBeNull();
  });
});

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
