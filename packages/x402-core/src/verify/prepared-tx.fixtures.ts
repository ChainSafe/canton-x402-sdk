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

/** A bare `<field>: <string>` entry, for building a repeated field by hand. */
export function stringField(field: number, s: string): Uint8Array {
  return Writer.create().uint32(tag(field, WIRE_LEN)).string(s).finish();
}

/** A Daml `Value` holding a scalar string in the given oneof field. */
function scalarValue(field: 6 | 7 | 8, s: string): Uint8Array {
  return Writer.create().uint32(tag(field, WIRE_LEN)).string(s).finish();
}
const party = (s: string) => scalarValue(7, s);
const numeric = (s: string) => scalarValue(6, s);
const text = (s: string) => scalarValue(8, s);

/** A Daml `Value` holding a `Time`: field 5, SFIXED64, eight little-endian bytes. */
function timestamp(micros: bigint): Uint8Array {
  const out = new Uint8Array(9);
  out[0] = (5 << 3) | 1; // wire type 1, not 2 — a Time is not length-delimited
  let v = BigInt.asUintN(64, micros);
  for (let i = 1; i <= 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** A Daml `Value` holding an empty `List`. */
const emptyList = Writer.create().uint32(tag(11, WIRE_LEN)).bytes(new Uint8Array()).finish();

/** A Daml `Value` holding a `TextMap{1: repeated Entry{1: key, 2: value}}`. */
function textMap(entries: [string, Uint8Array][]): Uint8Array {
  const map = Writer.create();
  for (const [key, value] of entries) {
    const entry = Writer.create().uint32(tag(1, WIRE_LEN)).string(key).uint32(tag(2, WIRE_LEN)).bytes(value);
    map.uint32(tag(1, WIRE_LEN)).bytes(entry.finish());
  }
  return Writer.create().uint32(tag(12, WIRE_LEN)).bytes(map.finish()).finish();
}

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
export type EncodeLayer =
  | "prepared"
  | "metadata"
  | "damlNode"
  | "node"
  | "exercise"
  | "receiverField"
  | "receiver";

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
  /**
   * `meta.values` entries verbatim, in place of the single `x402.memo` the
   * transfer's `memo` produces — for a repeated key, a non-text value, or
   * neighbouring keys the reader must ignore.
   */
  memoEntries?: [string, Uint8Array][];
  /**
   * The evidence the factory check reads: the exercised contract's id,
   * template and interface on the Exercise node, and the matching
   * `Metadata.input_contracts` entry.
   *
   * OFF by default, so every fixture written before the rule keeps the shape it
   * had. Each field below exists to build one refusal the rule has to make.
   */
  factory?: {
    /** The exercised contract id. */
    contractId?: string;
    /** The exercise's `template_id`. Defaults to the real Canton Coin factory. */
    templateId?: { packageId?: string; moduleName?: string; entityName?: string };
    /** The input contract's own template, when it must DISAGREE with the exercise's. */
    inputTemplateId?: { packageId?: string; moduleName?: string; entityName?: string };
    /** Defaults to the admin the transfer declares — what a real factory carries. */
    signatories?: readonly string[];
    /** No `input_contracts` entry at all: the exercised id resolves to nothing. */
    omitInputContract?: boolean;
    /** The entry written twice: the id resolves ambiguously. */
    duplicateInputContract?: boolean;
    /** The exercise's `interface_id`. Defaults to the Token Standard factory. */
    interfaceId?: { packageId?: string; moduleName?: string; entityName?: string };
    /** No `interface_id`: the choice was exercised on the template directly. */
    omitInterfaceId?: boolean;
    /** The input contract's `package_name`, when it must DISAGREE. */
    inputPackageName?: string;
  };
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
  // The real transfer always carries the trailing fields; fixtures opt in so
  // the ones written before them still encode byte-identically.
  const trailing =
    transfer.executeBeforeMicros !== undefined || transfer.memo !== undefined || opts.memoEntries !== undefined;
  const memoEntries: [string, Uint8Array][] =
    opts.memoEntries ?? (transfer.memo === undefined ? [] : [["x402.memo", text(transfer.memo)]]);

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
      // Declaration order continues: requestedAt, executeBefore,
      // inputHoldingCids, meta. All four or none — a positional record is read
      // by index, so emitting `meta` without the two before it would put it
      // where `executeBefore` belongs. A fixture that asks for neither gets
      // neither, which is what every pre-existing one does.
      ...(trailing
        ? [
            { label: "requestedAt", value: timestamp(0n) },
            { label: "executeBefore", value: timestamp(transfer.executeBeforeMicros ?? 0n) },
            { label: "inputHoldingCids", value: emptyList },
            {
              label: "meta",
              value: recordValue([{ label: "values", value: textMap(memoEntries) }], positional),
            },
          ]
        : []),
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
 * A contract id shaped like a real one: the hasher reads these as HEX
 * (`hexToBytes`), so a readable placeholder makes the fixture unhashable.
 */
const FACTORY_CID = "00f1e2d3c4b5a6978899aabbccddeeff00112233445566778899aabbccddeeff";

/**
 * The template a fixture's exercise carries by default. Canton Coin's, because
 * a realistic fixture should look like the common case — but nothing compares
 * it against this: the verifier matches the INTERFACE, and the package id is
 * compared against nothing at all. Kept obviously synthetic so it is not
 * mistaken for a pin on some Splice release.
 */
const AMULET_FACTORY = {
  packageId: "f".repeat(64),
  moduleName: "Splice.ExternalPartyAmuletRules",
  entityName: "ExternalPartyAmuletRules",
};

/**
 * The Token Standard interface the transfer choice is defined on. Its package
 * is NOT the implementation's — on a real payment the interface resolves to the
 * token-standard package while the template resolves to splice-amulet — so the
 * fixture keeps them distinct rather than reusing one id for both.
 */
const TRANSFER_FACTORY_INTERFACE = {
  packageId: "e".repeat(64),
  moduleName: "Splice.Api.Token.TransferInstructionV1",
  entityName: "TransferFactory",
};

/** The package name a real Canton Coin factory and its exercise both carry. */
const FACTORY_PACKAGE_NAME = "splice-amulet";

/** `Identifier{1: package_id, 2: module_name, 3: entity_name}`. */
function encodeIdentifier(id: { packageId?: string; moduleName?: string; entityName?: string } = {}): Uint8Array {
  return Writer.create()
    .uint32(tag(1, WIRE_LEN))
    .string(id.packageId ?? AMULET_FACTORY.packageId)
    .uint32(tag(2, WIRE_LEN))
    .string(id.moduleName ?? AMULET_FACTORY.moduleName)
    .uint32(tag(3, WIRE_LEN))
    .string(id.entityName ?? AMULET_FACTORY.entityName)
    .finish();
}

/**
 * `Metadata.InputContract{1: v1}` around a `Create{2: contract_id, 3: package_name,
 * 4: template_id, 6: signatories[]}` — the fields the factory check reads,
 * and no more.
 */
function encodeInputContract(
  contractId: string,
  templateId: Uint8Array,
  signatories: readonly string[],
  packageName: string,
): Uint8Array {
  const create = Writer.create()
    .uint32(tag(1, WIRE_LEN))
    .string("2.1")
    .uint32(tag(2, WIRE_LEN))
    .string(contractId)
    .uint32(tag(3, WIRE_LEN))
    .string(packageName);
  create.uint32(tag(4, WIRE_LEN)).bytes(templateId);
  // `argument` is not optional to the hasher — a Create without one is "value
  // is missing". The real factory's is a one-field record naming the DSO, so
  // the fixture carries the same shape.
  create
    .uint32(tag(5, WIRE_LEN))
    .bytes(recordValue([{ label: "dso", value: party(signatories[0] ?? "") }], false));
  for (const signatory of signatories) create.uint32(tag(6, WIRE_LEN)).string(signatory);
  return wrap(1, create.finish());
}

/**
 * Encode a `PreparedTransaction` base64 blob whose sole exercise is a
 * TransferFactory_Transfer for `transfer`. Field layout mirrors the decoder.
 */
export function encodePreparedTransaction(transfer: DecodedTransfer, opts: EncodeOptions = {}): string {
  const extra = opts.extra ?? {};

  // Exercise{9: choice_id, 10: chosen_value}
  // Exercise containing the transfer choice.
  const factory = opts.factory;
  const exercise = Writer.create().uint32(tag(1, WIRE_LEN)).string("2.1");
  if (factory) {
    exercise.uint32(tag(2, WIRE_LEN)).string(factory.contractId ?? FACTORY_CID);
    exercise.uint32(tag(3, WIRE_LEN)).string(FACTORY_PACKAGE_NAME);
  }
  exercise
    .uint32(tag(4, WIRE_LEN))
    .bytes(factory ? encodeIdentifier(factory.templateId) : new Uint8Array())
    .uint32(tag(7, WIRE_LEN))
    .string(transfer.sender);
  // 8: interface_id — the interface the choice was inherited from.
  if (factory && !factory.omitInterfaceId) {
    exercise
      .uint32(tag(8, WIRE_LEN))
      .bytes(encodeIdentifier({ ...TRANSFER_FACTORY_INTERFACE, ...factory.interfaceId }));
  }
  exercise
    .uint32(tag(9, WIRE_LEN))
    .string(opts.choiceId ?? "TransferFactory_Transfer")
    .uint32(tag(10, WIRE_LEN))
    .bytes(encodeChoiceArgument(transfer, opts));
  const exerciseBytes = exercise.finish();

  const nodeId = opts.nodeId ?? "0";
  const v1Node = concat(wrap(3, concat(exerciseBytes, extra.exercise)), extra.node);
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
    // What Canton signs: the PHYSICAL id. A fixture that passes none gets the
    // logical id the requirements fixtures quote, so the pin matches.
    .string(transfer.synchronizerId ?? "global-domain::1220be58c29e")
    .uint32(tag(5, WIRE_LEN))
    .string("test-transaction");
  if (factory && !factory.omitInputContract) {
    const entry = encodeInputContract(
      factory.contractId ?? FACTORY_CID,
      encodeIdentifier(factory.inputTemplateId ?? factory.templateId),
      factory.signatories ?? [transfer.instrumentId.admin],
      factory.inputPackageName ?? FACTORY_PACKAGE_NAME,
    );
    metadata.uint32(tag(7, WIRE_LEN)).bytes(entry);
    if (factory.duplicateInputContract) metadata.uint32(tag(7, WIRE_LEN)).bytes(entry);
  }
  const metadataBytes = concat(metadata.finish(), extra.metadata);

  const prepared = concat(
    Writer.create()
      .uint32(tag(1, WIRE_LEN))
      .bytes(damlTxn.finish())
      .uint32(tag(2, WIRE_LEN))
      .bytes(metadataBytes)
      .finish(),
    extra.prepared,
  );
  return bytesToBase64(prepared);
}
