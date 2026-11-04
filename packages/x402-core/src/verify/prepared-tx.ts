// Prepared-transaction decoder — extracts the transfer a Canton interactive-
// submission `PreparedTransaction` actually authorizes, so the verifier can bind
// it to the requirements (a signed payload must move what it committed to via
// `requirementsHash`, not something else).
//
// Isomorphic: uses protobufjs's minimal Reader (pure JS, no fs, no Buffer) over a
// base64→Uint8Array decode. Only the narrow field path we need is walked; every
// other field is skipped, so we don't vendor the full Canton proto closure.
// Every message on that path must be canonically encoded (`assertCanonical`,
// `assertSingleField`), the wire format is framed the way protobuf-java frames
// it (`StrictReader`), and only the node tree under the roots is read. So
// whenever Canton accepts the bytes, this walker reads the same transaction
// from them. (It may still accept some malformed bytes Canton refuses; those
// fail at settlement.)
//
// Envelope (see canton interactive_submission_service.proto + _data.proto):
//   PreparedTransaction{1: transaction}
//     → DamlTransaction{2: roots[], 3: nodes[]}
//       → DamlTransaction.Node{1: node_id, 1000: v1}
//         → Node{3: exercise | 4: rollback{1: children[]} | …}
//           → Exercise{9: choice_id, 10: chosen_value, 12: children[]}
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

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * protobufjs's Reader, made to agree with protobuf-java (what Canton parses
 * with) wherever the two would otherwise read the same bytes differently:
 * - a tag or length is a varint of at most 5 bytes. protobufjs skips a fixed
 *   10 bytes for a longer one, Java reads on to its terminator.
 * - a skipped varint value ends within 10 bytes. protobufjs reads on to the
 *   terminator however far it is, while protobuf-java 4.34+ ends a 64-bit
 *   varint at its 10th byte even when that byte asks for more.
 * - a string is valid UTF-8, BOM included. protobufjs drops stray bytes.
 * - groups (deprecated, never emitted by Canton) are refused. protobufjs ends
 *   one at any end-group tag, Java only at the matching one.
 */
class StrictReader extends Reader {
  override uint32(): number {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      if (this.pos >= this.len) throw new Error("truncated varint");
      const byte = this.buf[this.pos++];
      value = (value | ((byte & 0x7f) << (7 * i))) >>> 0;
      if (byte < 0x80) return value;
    }
    throw new Error("varint longer than 5 bytes");
  }

  override string(): string {
    return UTF8.decode(this.bytes());
  }

  override skip(length?: number): Reader {
    if (length !== undefined) return super.skip(length);
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.len) throw new Error("truncated varint");
      if (this.buf[this.pos++] < 0x80) return this;
    }
    throw new Error("varint longer than 10 bytes");
  }

  override skipType(wireType: number): Reader {
    if (wireType === 3 || wireType === 4) throw new Error("protobuf groups are not supported");
    return super.skipType(wireType);
  }
}

/**
 * A node id as Canton reads it: it parses ids as integers, so "0", "00", "+0"
 * and "٠" are all node 0 to Canton while a string compare tells them apart.
 * Only the canonical spelling of a non-negative int32 keeps the two in step.
 * Checked where a node is defined; a reference spelled any other way then
 * names no node and is refused as missing.
 */
function nodeIdOf(id: string): string {
  if (!/^(0|[1-9][0-9]{0,9})$/.test(id) || Number(id) > 2147483647) {
    throw new Error(`node id ${JSON.stringify(id)} is not a canonical integer`);
  }
  return id;
}

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
  const r = new StrictReader(bytes);
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

/** All strings of a repeated string `field`. */
function strings(bytes: Uint8Array, field: number): string[] {
  const r = new StrictReader(bytes);
  const out: string[] = [];
  while (r.pos < r.len) {
    const tag = r.uint32();
    if (tag >>> 3 === field && (tag & 7) === 2) out.push(r.string());
    else r.skipType(tag & 7);
  }
  return out;
}

/** How often each field number occurs in a message, regardless of wire type. */
function fieldCounts(bytes: Uint8Array): Map<number, number> {
  const counts = new Map<number, number>();
  const r = new StrictReader(bytes);
  while (r.pos < r.len) {
    const tag = r.uint32();
    counts.set(tag >>> 3, (counts.get(tag >>> 3) ?? 0) + 1);
    r.skipType(tag & 7);
  }
  return counts;
}

/**
 * Throw when a singular field is written more than once: protobuf MERGES the
 * copies, so a full decoder would not read what this walker reads. Canton
 * never emits it, so a real prepared transaction always passes.
 */
function assertCanonical(bytes: Uint8Array, singular: readonly number[]): void {
  const counts = fieldCounts(bytes);
  for (const field of singular) {
    if ((counts.get(field) ?? 0) > 1) throw new Error(`field ${field} is repeated`);
  }
}

/**
 * Throw unless a message that is nothing but a oneof (v1 `Node`, `Value`)
 * holds exactly one field. Protobuf keeps the LAST member, including members
 * newer than this walker (v1 `Node.query_by_key = 5`), while this walker would
 * read the first it knows; and Canton refuses one with no member at all.
 */
function assertSingleField(bytes: Uint8Array): void {
  let fields = 0;
  for (const count of fieldCounts(bytes).values()) fields += count;
  if (fields !== 1) throw new Error(`a oneof holds ${fields} members`);
}

/** Decode a Daml `Value` message (only the string scalars + nested record). */
function readValue(bytes: Uint8Array): ValueNode {
  assertSingleField(bytes);
  const r = new StrictReader(bytes);
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
  assertCanonical(bytes, [1, 2]);
  const r = new StrictReader(bytes);
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

/** Read an Exercise node's choice_id (9), chosen_value bytes (10) and children (12). */
function readExercise(bytes: Uint8Array): { choiceId: string; chosenValue: Uint8Array | null; children: string[] } {
  assertCanonical(bytes, [9, 10]);
  const r = new StrictReader(bytes);
  let choiceId = "";
  let chosenValue: Uint8Array | null = null;
  const children: string[] = [];
  while (r.pos < r.len) {
    const tag = r.uint32();
    const field = tag >>> 3;
    const wt = tag & 7;
    if (field === 9 && wt === 2) choiceId = r.string();
    else if (field === 10 && wt === 2) chosenValue = r.bytes();
    else if (field === 12 && wt === 2) children.push(r.string());
    else r.skipType(wt);
  }
  return { choiceId, chosenValue, children };
}

/** Read a `DamlTransaction.Node{1: node_id, 1000: v1}`. Any other field is refused. */
function readNode(bytes: Uint8Array): { nodeId: string; v1: Uint8Array } {
  assertCanonical(bytes, [1, 1000]);
  const r = new StrictReader(bytes);
  let nodeId: string | undefined;
  let v1: Uint8Array | undefined;
  while (r.pos < r.len) {
    const tag = r.uint32();
    const field = tag >>> 3;
    const wt = tag & 7;
    if (field === 1 && wt === 2) nodeId = nodeIdOf(r.string());
    else if (field === 1000 && wt === 2) v1 = r.bytes();
    else throw new Error(`unexpected field ${field} in a node`);
  }
  if (nodeId === undefined || v1 === undefined) throw new Error("node without an id or a v1 body");
  return { nodeId, v1 };
}

/** Read the TransferFactory_Transfer argument record `{ expectedAdmin, transfer }`. */
function readTransfer(chosenValue: Uint8Array): DecodedTransfer | null {
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

/**
 * Decode the `preparedTransaction` blob (base64) into the transfer it authorizes,
 * or `null` if it can't be decoded or contains no `TransferFactory_Transfer`
 * exercise. Never throws — an undecodable blob is treated as "no proof of a
 * matching transfer" and rejected upstream.
 */
export function decodePreparedTransaction(preparedTransactionBase64: string): DecodedTransfer | null {
  try {
    const prepared = base64ToBytes(preparedTransactionBase64);
    assertCanonical(prepared, [1]);
    const txn = firstSub(prepared, 1); // PreparedTransaction.transaction
    if (!txn) return null;

    // DamlTransaction{2: roots[], 3: nodes[]}. Canton keeps the LAST node of a
    // repeated id and refuses nodes the roots cannot reach, and the signed hash
    // covers only the tree under the roots. So read exactly that tree.
    const nodes = new Map<string, Uint8Array>();
    for (const bytes of subMessages(txn, 3)) {
      const { nodeId, v1 } = readNode(bytes);
      if (nodes.has(nodeId)) throw new Error(`node ${nodeId} is repeated`);
      nodes.set(nodeId, v1);
    }

    const reached = new Set<string>();
    const stack: { nodeId: string; rolledBack: boolean }[] = [];
    const reach = (ids: string[], rolledBack: boolean): void => {
      // Pushed in reverse so nodes are visited in the order the tree lists them.
      for (const nodeId of [...ids].reverse()) {
        if (reached.has(nodeId)) throw new Error(`node ${nodeId} is referenced twice`);
        reached.add(nodeId);
        stack.push({ nodeId, rolledBack });
      }
    };
    reach(strings(txn, 2), false);

    let transferArg: Uint8Array | null | undefined; // the first TransferFactory_Transfer's chosen_value
    for (let next = stack.pop(); next; next = stack.pop()) {
      const v1 = nodes.get(next.nodeId);
      if (!v1) throw new Error(`node ${next.nodeId} is missing`);
      assertSingleField(v1); // create=1 | fetch=2 | exercise=3 | rollback=4 | query_by_key=5
      const rollback = firstSub(v1, 4);
      if (rollback) reach(strings(rollback, 1), true); // Rollback{1: children[]}
      const exercise = firstSub(v1, 3);
      if (!exercise) continue;

      const { choiceId, chosenValue, children } = readExercise(exercise);
      reach(children, next.rolledBack);
      if (choiceId !== TRANSFER_CHOICE) continue;
      // A transfer under a rollback node moves nothing.
      if (next.rolledBack) throw new Error("transfer under a rollback node");
      if (transferArg === undefined) transferArg = chosenValue;
    }
    if (reached.size !== nodes.size) throw new Error("a node is not reachable from the roots");

    return transferArg ? readTransfer(transferArg) : null;
  } catch {
    return null;
  }
}
