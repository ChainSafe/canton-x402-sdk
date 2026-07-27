// Prepared-transaction decoder — extracts the transfer a Canton interactive-
// submission `PreparedTransaction` actually authorizes, so the verifier can bind
// it to the requirements (a signed payload must move what it committed to via
// `requirementsHash`, not something else).
//
// Isomorphic: uses protobufjs's minimal Reader (pure JS, no fs, no Buffer) over a
// base64→Uint8Array decode. Only the narrow field path we need is walked; every
// other field is skipped, so we don't vendor the full Canton proto closure.
//
// Envelope (see canton interactive_submission_service.proto + _data.proto):
//   PreparedTransaction{1: transaction}
//     → DamlTransaction{3: nodes[]}
//       → DamlTransaction.Node{1000: v1}
//         → Node{3: exercise}
//           → Exercise{9: choice_id, 10: chosen_value}
//             → Value{14: record} → Record{2: fields[]} → RecordField{1: label, 2: value}
// Value scalar oneof: numeric=6, party=7, text=8 (all length-delimited strings).
//
// SPDX-License-Identifier: Apache-2.0

import { Reader } from "protobufjs/minimal";

/**
 * The transfer a prepared transaction authorizes, decoded out of the opaque
 * `preparedTransaction` blob. Checked against the requirements by the verifier.
 */
export interface DecodedTransfer {
  /** Paying party — must equal the payment payload's `payer`. */
  sender: string;
  /** Receiving party — must equal `requirements.payTo`. */
  receiver: string;
  /** Transfer amount as a decimal string — must be ≥ `requirements.maxAmountRequired`. */
  amount: string;
  /** Instrument moved — must equal `requirements.asset.instrumentId`. */
  instrumentId: { id: string; admin: string };
}

const TRANSFER_CHOICE = "TransferFactory_Transfer";

// ── protobuf wire helpers (over protobufjs minimal Reader) ──────────────────

/** A decoded Daml `Value`: either a scalar string (party/text/numeric) or a record. */
interface ValueNode {
  str?: string;
  record?: RecordFieldNode[];
}
interface RecordFieldNode {
  label: string;
  value: ValueNode;
}

/** base64 → bytes. Isomorphic: `atob` is global in Node 18+ and browsers. */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** All length-delimited (wire type 2) sub-message byte slices for `field`. */
function subMessages(bytes: Uint8Array, field: number): Uint8Array[] {
  const r = Reader.create(bytes);
  const out: Uint8Array[] = [];
  while (r.pos < r.len) {
    const tag = r.uint32();
    if (tag >>> 3 === field && (tag & 7) === 2) out.push(r.bytes());
    else r.skipType(tag & 7);
  }
  return out;
}

/** First sub-message for `field`, or null. */
function firstSub(bytes: Uint8Array, field: number): Uint8Array | null {
  return subMessages(bytes, field)[0] ?? null;
}

/** Decode a Daml `Value` message (only the string scalars + nested record). */
function readValue(bytes: Uint8Array): ValueNode {
  const r = Reader.create(bytes);
  const out: ValueNode = {};
  while (r.pos < r.len) {
    const tag = r.uint32();
    const field = tag >>> 3;
    const wt = tag & 7;
    if ((field === 6 || field === 7 || field === 8) && wt === 2) {
      out.str = r.string(); // numeric | party | text
    } else if (field === 14 && wt === 2) {
      out.record = readRecordFields(r.bytes()); // record
    } else {
      r.skipType(wt);
    }
  }
  return out;
}

/** Decode `Record.fields` (repeated RecordField at field 2). */
function readRecordFields(recordBytes: Uint8Array): RecordFieldNode[] {
  return subMessages(recordBytes, 2).map(readRecordField);
}

/** Decode a `RecordField{1: label, 2: value}`. */
function readRecordField(bytes: Uint8Array): RecordFieldNode {
  const r = Reader.create(bytes);
  let label = "";
  let value: ValueNode = {};
  while (r.pos < r.len) {
    const tag = r.uint32();
    const field = tag >>> 3;
    const wt = tag & 7;
    if (field === 1 && wt === 2) label = r.string();
    else if (field === 2 && wt === 2) value = readValue(r.bytes());
    else r.skipType(wt);
  }
  return { label, value };
}

/**
 * Pick a record field by label, falling back to positional index. A Daml LF
 * record is encoded either fully-labeled or fully-positional (proto rule), so we
 * detect which and use the matching strategy. The positional order mirrors the
 * choice/record's Daml declaration order.
 */
function pick(fields: RecordFieldNode[], label: string, index: number): ValueNode | undefined {
  const labeled = fields.some((f) => f.label !== "");
  return labeled ? fields.find((f) => f.label === label)?.value : fields[index]?.value;
}

/** Read an Exercise node's choice_id (9) + chosen_value bytes (10). */
function readExercise(bytes: Uint8Array): { choiceId: string; chosenValue: Uint8Array | null } {
  const r = Reader.create(bytes);
  let choiceId = "";
  let chosenValue: Uint8Array | null = null;
  while (r.pos < r.len) {
    const tag = r.uint32();
    const field = tag >>> 3;
    const wt = tag & 7;
    if (field === 9 && wt === 2) choiceId = r.string();
    else if (field === 10 && wt === 2) chosenValue = r.bytes();
    else r.skipType(wt);
  }
  return { choiceId, chosenValue };
}

/**
 * Decode the `preparedTransaction` blob (base64) into the transfer it authorizes,
 * or `null` if it can't be decoded or contains no `TransferFactory_Transfer`
 * exercise. Never throws — an undecodable blob is treated as "no proof of a
 * matching transfer" and rejected upstream.
 */
export function decodePreparedTransaction(preparedTransactionBase64: string): DecodedTransfer | null {
  try {
    const prepared = base64ToBytes(preparedTransactionBase64);
    const txn = firstSub(prepared, 1); // PreparedTransaction.transaction
    if (!txn) return null;

    for (const node of subMessages(txn, 3)) {
      // DamlTransaction.Node → 1000: v1 Node → 3: exercise
      const v1 = firstSub(node, 1000);
      if (!v1) continue;
      const exercise = firstSub(v1, 3);
      if (!exercise) continue;
      const { choiceId, chosenValue } = readExercise(exercise);
      if (choiceId !== TRANSFER_CHOICE || !chosenValue) continue;

      // chosen_value: TransferFactory_Transfer arg record { expectedAdmin, transfer }
      const arg = readValue(chosenValue).record;
      if (!arg) return null;
      const transfer = pick(arg, "transfer", 1)?.record;
      if (!transfer) return null;

      const sender = pick(transfer, "sender", 0)?.str;
      const receiver = pick(transfer, "receiver", 1)?.str;
      const amount = pick(transfer, "amount", 2)?.str;
      const instr = pick(transfer, "instrumentId", 3)?.record;
      const id = instr && pick(instr, "id", 0)?.str;
      const admin = instr && pick(instr, "admin", 1)?.str;

      if (!sender || !receiver || !amount || !id || !admin) return null;
      return { sender, receiver, amount, instrumentId: { id, admin } };
    }
    return null;
  } catch {
    return null;
  }
}
