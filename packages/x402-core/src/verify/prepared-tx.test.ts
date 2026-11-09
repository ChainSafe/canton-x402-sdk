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
/** A Daml `Value` holding text — for building `meta.values` entries by hand. */
const textValue = (t: string) => concat(new Uint8Array([(8 << 3) | 2, utf8(t).length]), utf8(t));
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
    // Exercise.consuming as a varint whose 10th byte keeps its continuation
    // bit: protobufjs reads on to the 11th, protobuf-java 4.34+ stops at the 10th.
    ["a varint value that runs past 10 bytes", [0x58, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x81, 0x00]],
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

  it("decodes a transfer that is the transaction's only root", () => {
    expect(decodePreparedTransaction(encodePreparedTransaction(TRANSFER))).toEqual(TRANSFER);
  });

  it("decodes a transfer whose own consequence is a rollback", () => {
    // Children the transfer's choice produces are part of the payment, so they
    // must still decode — and their nodes must be walked, or the reachability
    // check reports them as orphans and refuses a legitimate transaction.
    const blob = encodePreparedTransaction(TRANSFER, {
      extra: { exercise: wrap(12, utf8("1")) }, // Exercise{12: children} → "1"
      nodes: [encodeNode("1", rollbackOf("2")), encodeNode("2", create)],
    });
    expect(decodePreparedTransaction(blob)).toEqual(TRANSFER);
  });

  it("refuses a child that names no node, even when an orphan balances the count", () => {
    // Without the missing-node check the phantom child is skipped, the orphan
    // makes reached.size === nodes.size, and the unreachable node rides along.
    const blob = encodePreparedTransaction(TRANSFER, {
      extra: { exercise: wrap(12, utf8("99")) }, // child "99" does not exist
      nodes: [encodeNode("5", create)], // orphan, balancing the count
    });
    expect(decodePreparedTransaction(blob)).toBeNull();
  });

  it("refuses a transfer nested under another exercise", () => {
    // The payer would be having the facilitator relay, and pay for, whatever
    // the outer choice does — none of which the verifier looked at.
    const blob = encodePreparedTransaction(TRANSFER, {
      nodeId: "1",
      roots: ["0"],
      nodes: [encodeNode("0", parentOf("1"))],
    });
    expect(decodePreparedTransaction(blob)).toBeNull();
  });

  it("refuses a transfer next to a second root", () => {
    // A payment is one command, so its transaction is one tree. A sibling root
    // is another leg, whatever it happens to contain.
    const blob = encodePreparedTransaction(TRANSFER, {
      roots: ["0", "1"],
      nodes: [encodeNode("1", rollbackOf("2")), encodeNode("2", create)],
    });
    expect(decodePreparedTransaction(blob)).toBeNull();
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
    // Canton runs every transfer in the tree, so reporting the first would
    // describe a payment the caller never made.
    ["a second transfer under a second root", { roots: ["0", "1"], nodes: [encodeNode("1", transferBody(OTHER))] }],
    [
      "a second transfer nested under the first",
      { extra: { exercise: wrap(12, utf8("1")) }, nodes: [encodeNode("1", transferBody(OTHER))] },
    ],
  ];

  it.each(cases)("returns null for %s", (_, opts) => {
    expect(decodePreparedTransaction(encodePreparedTransaction(TRANSFER, opts))).toBeNull();
  });
});

describe("the deadline and the memo", () => {
  const DEADLINE = 1_762_300_000_000_000n; // µs
  const dated = { ...TRANSFER, executeBeforeMicros: DEADLINE };

  it.each([false, true])("round-trips executeBefore, positional=%s", (positional) => {
    const got = decodePreparedTransaction(encodePreparedTransaction(dated, { positional }));
    expect(got?.executeBeforeMicros).toBe(DEADLINE);
  });

  it("reads it as a signed 64-bit value, not a varint", () => {
    // A Daml `Time` is an SFIXED64, so it is eight little-endian bytes behind a
    // wire-type-1 tag. A reader that only handles length-delimited members
    // skips it and reports no deadline at all — which Rule 10 would then have
    // to treat as a pass or refuse every real payment.
    for (const micros of [0n, 1n, -1n, (1n << 62n) - 1n, -(1n << 62n)]) {
      const got = decodePreparedTransaction(encodePreparedTransaction({ ...TRANSFER, executeBeforeMicros: micros }));
      expect(got?.executeBeforeMicros).toBe(micros);
    }
  });

  it("reports no deadline when the transfer carries none", () => {
    expect(decodePreparedTransaction(encodePreparedTransaction(TRANSFER))?.executeBeforeMicros).toBeUndefined();
  });

  it.each([false, true])("round-trips the memo, positional=%s", (positional) => {
    const got = decodePreparedTransaction(
      encodePreparedTransaction({ ...dated, memo: "invoice-2024-001" }, { positional }),
    );
    expect(got?.memo).toBe("invoice-2024-001");
  });

  it("reads only its own key, and only from meta.values", () => {
    const blob = encodePreparedTransaction(dated, {
      memoEntries: [
        // What the wallet SDK writes for its own `memo` parameter. Reading it
        // as ours would let a payer satisfy Rule 12 without signing our key.
        ["splice.lfdecentralizedtrust.org/reason", textValue("the SDK's own memo")],
        ["x402.memo", textValue("ours")],
        ["x402.memo.other", textValue("not ours either")],
      ],
    });
    expect(decodePreparedTransaction(blob)?.memo).toBe("ours");
  });

  it("reports no memo when the map has none", () => {
    expect(decodePreparedTransaction(encodePreparedTransaction(dated, { memoEntries: [] }))?.memo).toBeUndefined();
  });

  it("refuses a repeated x402.memo rather than picking one", () => {
    // Two entries are two answers to what the payer committed to. Any
    // last-wins rule lets a producer show one value here and another to the
    // engine, which is the whole point of binding the memo.
    const blob = encodePreparedTransaction(dated, {
      memoEntries: [
        ["x402.memo", textValue("shown")],
        ["x402.memo", textValue("executed")],
      ],
    });
    expect(decodePreparedTransaction(blob)).toBeNull();
  });
});

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
