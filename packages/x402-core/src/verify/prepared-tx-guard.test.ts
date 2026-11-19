import { describe, expect, it } from "vitest";
import {
  encodePreparedTransaction,
  encodePreparedTransactionGraph,
  stringField,
  wrap,
} from "./prepared-tx.fixtures";
import {
  guardPreparedTransaction,
  MAX_PREPARED_TRANSACTION_BASE64_LENGTH,
  MAX_PREPARED_TRANSACTION_INPUT_CONTRACTS,
  MAX_PREPARED_TRANSACTION_NODES,
} from "./prepared-tx-guard";

describe("guardPreparedTransaction", () => {
  it("accepts a real prepared-transaction fixture", () => {
    const preparedTransaction = encodePreparedTransaction({
      sender: "alice::fingerprint",
      receiver: "merchant::fingerprint",
      amount: "1.0",
      instrumentId: { id: "Amulet", admin: "DSO::fingerprint" },
    });

    expect(guardPreparedTransaction(preparedTransaction)).toEqual({ ok: true });
  });

  it("accepts a tree in which each node is referenced once", () => {
    const preparedTransaction = encodePreparedTransactionGraph(
      ["0"],
      [
        { id: "0", children: ["1", "2"] },
        { id: "1", children: [] },
        { id: "2", children: [] },
      ],
    );

    expect(guardPreparedTransaction(preparedTransaction)).toEqual({ ok: true });
  });

  it("rejects an oversized blob before decoding", () => {
    const preparedTransaction = "A".repeat(MAX_PREPARED_TRANSACTION_BASE64_LENGTH + 1);
    expect(guardPreparedTransaction(preparedTransaction)).toEqual({
      ok: false,
      reason: "size_limit",
    });
  });

  it("rejects a malformed prepared transaction", () => {
    expect(guardPreparedTransaction("not-base64!!")).toEqual({
      ok: false,
      reason: "structure_undecodable",
    });
  });

  it("rejects a node id that is not a canonical integer", () => {
    // Canton parses node ids as integers, so "00" and "0" are one node to it
    // and two to a string-keyed reader. Refused where a node is DEFINED; the
    // try/catch here is what turns the decoder's throw into a reason rather
    // than a 500 out of verify.
    const preparedTransaction = encodePreparedTransactionGraph(["00"], [{ id: "00", children: [] }]);
    expect(guardPreparedTransaction(preparedTransaction)).toEqual({
      ok: false,
      reason: "non_canonical_node_id",
    });
  });

  it("rejects a prepared transaction carrying a field the schema does not define", () => {
    // The hash cannot cover a field it cannot see, so reading past one would
    // bind the requirements to bytes nobody signed. `readUnknownField: "throw"`
    // is what refuses it, and the catch above turns that into `structure_undecodable`.
    const preparedTransaction = encodePreparedTransaction(
      {
        sender: "alice::fingerprint",
        receiver: "merchant::fingerprint",
        amount: "1.0",
        instrumentId: { id: "Amulet", admin: "DSO::fingerprint" },
      },
      { extra: { prepared: wrap(15, stringField(1, "unsigned")) } },
    );
    expect(guardPreparedTransaction(preparedTransaction)).toEqual({
      ok: false,
      reason: "structure_undecodable",
    });
  });

  it("rejects more than the permitted number of nodes", () => {
    const nodes = Array.from({ length: MAX_PREPARED_TRANSACTION_NODES + 1 }, (_, index) => ({
      id: String(index),
      children: new Array<string>(),
    }));
    const preparedTransaction = encodePreparedTransactionGraph(
      nodes.map((node) => node.id),
      nodes,
    );

    expect(guardPreparedTransaction(preparedTransaction)).toEqual({
      ok: false,
      reason: "node_limit",
    });
  });

  it("accepts one node seed per node", () => {
    const preparedTransaction = encodePreparedTransactionGraph(["0"], [{ id: "0", children: [] }], {
      nodeSeedCount: 1,
    });

    expect(guardPreparedTransaction(preparedTransaction)).toEqual({ ok: true });
  });

  it("rejects more node seeds than nodes", () => {
    const preparedTransaction = encodePreparedTransactionGraph(["0"], [{ id: "0", children: [] }], {
      nodeSeedCount: 2,
    });

    expect(guardPreparedTransaction(preparedTransaction)).toEqual({
      ok: false,
      reason: "node_seed_limit",
    });
  });

  it("accepts the maximum permitted number of input contracts", () => {
    const preparedTransaction = encodePreparedTransactionGraph(["0"], [{ id: "0", children: [] }], {
      inputContractCount: MAX_PREPARED_TRANSACTION_INPUT_CONTRACTS,
    });

    expect(guardPreparedTransaction(preparedTransaction)).toEqual({ ok: true });
  });

  it("rejects more than the permitted number of input contracts", () => {
    const preparedTransaction = encodePreparedTransactionGraph(["0"], [{ id: "0", children: [] }], {
      inputContractCount: MAX_PREPARED_TRANSACTION_INPUT_CONTRACTS + 1,
    });

    expect(guardPreparedTransaction(preparedTransaction)).toEqual({
      ok: false,
      reason: "input_contract_limit",
    });
  });

  it.each([
    {
      name: "a self-cycle",
      roots: ["0"],
      nodes: [{ id: "0", children: ["0"] }],
      reason: "duplicate_reference",
    },
    {
      name: "a multi-node cycle",
      roots: ["0"],
      nodes: [
        { id: "0", children: ["1"] },
        { id: "1", children: ["0"] },
      ],
      reason: "duplicate_reference",
    },
    {
      name: "a child shared by two parents",
      roots: ["0", "1"],
      nodes: [
        { id: "0", children: ["2"] },
        { id: "1", children: ["2"] },
        { id: "2", children: [] },
      ],
      reason: "duplicate_reference",
    },
    {
      name: "duplicate roots",
      roots: ["0", "0"],
      nodes: [{ id: "0", children: [] }],
      reason: "duplicate_reference",
    },
    {
      name: "duplicate node ids",
      roots: ["0"],
      nodes: [
        { id: "0", children: [] },
        { id: "0", children: [] },
      ],
      reason: "duplicate_node_id",
    },
    {
      name: "a missing child",
      roots: ["0"],
      nodes: [{ id: "0", children: ["1"] }],
      reason: "missing_node",
    },
    {
      name: "an unreachable node",
      roots: ["0"],
      nodes: [
        { id: "0", children: [] },
        { id: "1", children: [] },
      ],
      reason: "unreachable_node",
    },
  ])("rejects $name", ({ roots, nodes, reason }) => {
    expect(guardPreparedTransaction(encodePreparedTransactionGraph(roots, nodes))).toEqual({
      ok: false,
      reason,
    });
  });
});
