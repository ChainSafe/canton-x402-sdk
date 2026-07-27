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
}

/** A Daml `Value` holding a record. `positional` omits labels (order-only). */
function recordValue(fields: Field[], positional: boolean): Uint8Array {
  const record = Writer.create();
  for (const f of fields) {
    const rf = Writer.create();
    if (!positional) rf.uint32(tag(1, WIRE_LEN)).string(f.label);
    rf.uint32(tag(2, WIRE_LEN)).bytes(f.value);
    record.uint32(tag(2, WIRE_LEN)).bytes(rf.finish()); // Record.fields (repeated)
  }
  return Writer.create().uint32(tag(14, WIRE_LEN)).bytes(record.finish()).finish();
}

/** Wrap `inner` bytes as a single length-delimited field. */
function wrap(field: number, inner: Uint8Array): Uint8Array {
  return Writer.create().uint32(tag(field, WIRE_LEN)).bytes(inner).finish();
}

export interface EncodeOptions {
  /** Encode records without labels (order-only) to exercise the positional path. */
  positional?: boolean;
  /** Override the choice id (defaults to TransferFactory_Transfer). */
  choiceId?: string;
}

/**
 * Encode a `PreparedTransaction` base64 blob whose sole exercise is a
 * TransferFactory_Transfer for `transfer`. Field layout mirrors the decoder.
 */
export function encodePreparedTransaction(transfer: DecodedTransfer, opts: EncodeOptions = {}): string {
  const positional = opts.positional ?? false;

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
      { label: "receiver", value: party(transfer.receiver) },
      { label: "amount", value: numeric(transfer.amount) },
      { label: "instrumentId", value: instrument },
    ],
    positional,
  );
  const choiceArg = recordValue(
    [
      { label: "expectedAdmin", value: party(transfer.instrumentId.admin) },
      { label: "transfer", value: transferRecord },
    ],
    positional,
  );

  // Exercise{9: choice_id, 10: chosen_value}
  const exercise = Writer.create()
    .uint32(tag(9, WIRE_LEN))
    .string(opts.choiceId ?? "TransferFactory_Transfer")
    .uint32(tag(10, WIRE_LEN))
    .bytes(choiceArg)
    .finish();

  const v1Node = wrap(3, exercise); // Node{3: exercise}
  const damlNode = wrap(1000, v1Node); // DamlTransaction.Node{1000: v1}
  const damlTxn = wrap(3, damlNode); // DamlTransaction{3: nodes[]}
  const prepared = wrap(1, damlTxn); // PreparedTransaction{1: transaction}
  return bytesToBase64(prepared);
}
