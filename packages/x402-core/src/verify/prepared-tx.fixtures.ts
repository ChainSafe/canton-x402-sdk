// Test-only encoder: builds a Canton `PreparedTransaction` blob carrying a
// TransferFactory_Transfer exercise, the inverse of prepared-tx.ts's decoder.
// Used to round-trip the decoder and to give verifier fixtures a real blob —
// no localnet needed. NOT part of the published surface (not reached from
// src/index.ts, so tsup never bundles it).
//
// SPDX-License-Identifier: Apache-2.0

import { Writer } from "protobufjs/minimal";
import type { DecodedTransfer } from "./prepared-tx";

const WIRE_LEN = 2; // length-delimited
function tag(field: number, wireType: number): number {
  return (field << 3) | wireType;
}

/** bytes → base64 (isomorphic). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** A Daml `Value` holding a scalar string in the given oneof field. */
function scalarValue(field: 6 | 7 | 8, s: string): Uint8Array {
  return Writer.create().uint32(tag(field, WIRE_LEN)).string(s).finish();
}
const party = (s: string) => scalarValue(7, s);
const numeric = (s: string) => scalarValue(6, s);
const text = (s: string) => scalarValue(8, s);

interface Field {
  label: string;
  value: Uint8Array;
  /** Raw bytes appended to this `RecordField` after its label and value. */
  extra?: Uint8Array;
}

/** A Daml `Value` holding a record. `positional` omits labels (order-only). */
function recordValue(fields: Field[], positional: boolean): Uint8Array {
  const record = Writer.create();
  for (const f of fields) {
    const rf = Writer.create();
    if (!positional) rf.uint32(tag(1, WIRE_LEN)).string(f.label);
    rf.uint32(tag(2, WIRE_LEN)).bytes(f.value);
    record.uint32(tag(2, WIRE_LEN)).bytes(concat(rf.finish(), f.extra)); // Record.fields (repeated)
  }
  return Writer.create().uint32(tag(14, WIRE_LEN)).bytes(record.finish()).finish();
}

/** Wrap `inner` bytes as a single length-delimited field. */
export function wrap(field: number, inner: Uint8Array): Uint8Array {
  return Writer.create().uint32(tag(field, WIRE_LEN)).bytes(inner).finish();
}

function concat(bytes: Uint8Array, extra?: Uint8Array): Uint8Array {
  if (!extra) return bytes;
  const out = new Uint8Array(bytes.length + extra.length);
  out.set(bytes);
  out.set(extra, bytes.length);
  return out;
}

/**
 * The layers the decoder reads, outermost first. `extra` appends raw bytes to
 * one of them, after its honest content, to build non-canonical encodings.
 */
export type EncodeLayer = "prepared" | "damlNode" | "node" | "exercise" | "receiverField" | "receiver";

export interface EncodeOptions {
  /** Encode records without labels (order-only) to exercise the positional path. */
  positional?: boolean;
  /** Override the choice id (defaults to TransferFactory_Transfer). */
  choiceId?: string;
  /** Raw bytes appended to a layer, e.g. `{ node: wrap(1, new Uint8Array()) }`. */
  extra?: Partial<Record<EncodeLayer, Uint8Array>>;
  /** The transfer node's id (defaults to "0"). */
  nodeId?: string;
  /** `DamlTransaction.roots` (defaults to the transfer node alone). */
  roots?: string[];
  /** Further `DamlTransaction.nodes` (see `encodeNode`), listed after the transfer node. */
  nodes?: Uint8Array[];
}

/** A `DamlTransaction.Node{1: node_id, 1000: v1}` around a v1 `Node` body. */
export function encodeNode(nodeId: string, v1: Uint8Array): Uint8Array {
  return Writer.create()
    .uint32(tag(1, WIRE_LEN))
    .string(nodeId)
    .uint32(tag(1000, WIRE_LEN))
    .bytes(v1)
    .finish();
}

export interface PreparedTransactionGraphNode {
  id: string;
  children: string[];
}

export interface PreparedTransactionGraphOptions {
  nodeSeedCount?: number;
  inputContractCount?: number;
}

/** Encode a minimal rollback-only graph for structural validation tests. */
export function encodePreparedTransactionGraph(
  roots: string[],
  nodes: PreparedTransactionGraphNode[],
  options: PreparedTransactionGraphOptions = {},
): string {
  const damlTxn = Writer.create().uint32(tag(1, WIRE_LEN)).string("2.1");

  for (const root of roots) {
    damlTxn.uint32(tag(2, WIRE_LEN)).string(root);
  }

  for (const node of nodes) {
    const rollback = Writer.create();

    for (const child of node.children) {
      rollback.uint32(tag(1, WIRE_LEN)).string(child);
    }

    const damlNode = Writer.create()
      .uint32(tag(1, WIRE_LEN))
      .string(node.id)
      .uint32(tag(1000, WIRE_LEN))
      .bytes(wrap(4, rollback.finish()))
      .finish();

    damlTxn.uint32(tag(3, WIRE_LEN)).bytes(damlNode);
  }
  for (let index = 0; index < (options.nodeSeedCount ?? 0); index += 1) {
    const nodeSeed = Writer.create()
      .uint32(tag(1, 0))
      .int32(index)
      .uint32(tag(2, WIRE_LEN))
      .bytes(new Uint8Array())
      .finish();
    damlTxn.uint32(tag(4, WIRE_LEN)).bytes(nodeSeed);
  }

  const metadata = Writer.create();
  for (let index = 0; index < (options.inputContractCount ?? 0); index += 1) {
    metadata.uint32(tag(7, WIRE_LEN)).bytes(new Uint8Array());
  }

  return bytesToBase64(
    Writer.create()
      .uint32(tag(1, WIRE_LEN))
      .bytes(damlTxn.finish())
      .uint32(tag(2, WIRE_LEN))
      .bytes(metadata.finish())
      .finish(),
  );
}

/** The TransferFactory_Transfer argument for `transfer`, as the exercise's `chosen_value`. */
export function encodeChoiceArgument(
  transfer: DecodedTransfer,
  opts: EncodeOptions = {},
): Uint8Array {
  const positional = opts.positional ?? false;
  const extra = opts.extra ?? {};

  const instrument = recordValue(
    [
      { label: "id", value: text(transfer.instrumentId.id) },
      { label: "admin", value: party(transfer.instrumentId.admin) },
    ],
    positional,
  );
  const transferRecord = recordValue(
    [
      { label: "sender", value: party(transfer.sender) },
      {
        label: "receiver",
        value: concat(party(transfer.receiver), extra.receiver),
        extra: extra.receiverField,
      },
      { label: "amount", value: numeric(transfer.amount) },
      { label: "instrumentId", value: instrument },
    ],
    positional,
  );
  return recordValue(
    [
      { label: "expectedAdmin", value: party(transfer.instrumentId.admin) },
      { label: "transfer", value: transferRecord },
    ],
    positional,
  );
}

/**
 * Encode a `PreparedTransaction` base64 blob whose sole exercise is a
 * TransferFactory_Transfer for `transfer`. Field layout mirrors the decoder.
 */
export function encodePreparedTransaction(transfer: DecodedTransfer, opts: EncodeOptions = {}): string {
  const extra = opts.extra ?? {};

  // Exercise{9: choice_id, 10: chosen_value}
  // Exercise containing the transfer choice.
  const exercise = Writer.create()
    .uint32(tag(1, WIRE_LEN))
    .string("2.1")
    .uint32(tag(4, WIRE_LEN))
    .bytes(new Uint8Array())
    .uint32(tag(7, WIRE_LEN))
    .string(transfer.sender)
    .uint32(tag(9, WIRE_LEN))
    .string(opts.choiceId ?? "TransferFactory_Transfer")
    .uint32(tag(10, WIRE_LEN))
    .bytes(encodeChoiceArgument(transfer, opts))
    .finish();

  const nodeId = opts.nodeId ?? "0";
  const v1Node = concat(wrap(3, concat(exercise, extra.exercise)), extra.node);
  const damlNode = concat(encodeNode(nodeId, v1Node), extra.damlNode);

  const nodeSeed = Writer.create()
    .uint32(tag(1, 0))
    .int32(0)
    .uint32(tag(2, WIRE_LEN))
    .bytes(new Uint8Array(32).fill(1))
    .finish();

  const damlTxn = Writer.create()
    .uint32(tag(1, WIRE_LEN))
    .string("2.1");

  for (const root of opts.roots ?? [nodeId]) {
    damlTxn.uint32(tag(2, WIRE_LEN)).string(root);
  }

  for (const node of [damlNode, ...(opts.nodes ?? [])]) {
    damlTxn.uint32(tag(3, WIRE_LEN)).bytes(node);
  }

  damlTxn.uint32(tag(4, WIRE_LEN)).bytes(nodeSeed);

  const submitterInfo = Writer.create()
    .uint32(tag(1, WIRE_LEN))
    .string(transfer.sender)
    .uint32(tag(2, WIRE_LEN))
    .string("test-command")
    .finish();

  const metadata = Writer.create()
    .uint32(tag(2, WIRE_LEN))
    .bytes(submitterInfo)
    .uint32(tag(3, WIRE_LEN))
    .string("test-synchronizer")
    .uint32(tag(5, WIRE_LEN))
    .string("test-transaction")
    .finish();

  const prepared = concat(
    Writer.create()
      .uint32(tag(1, WIRE_LEN))
      .bytes(damlTxn.finish())
      .uint32(tag(2, WIRE_LEN))
      .bytes(metadata)
      .finish(),
    extra.prepared,
  );
  return bytesToBase64(prepared);
}
