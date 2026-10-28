import { describe, expect, it } from "vitest";
import { encodePreparedTransaction, encodePreparedTransactionGraph } from "./prepared-tx.fixtures";
import {
  guardPreparedTransaction,
  MAX_PREPARED_TRANSACTION_BASE64_LENGTH,
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
      reason: "undecodable",
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
