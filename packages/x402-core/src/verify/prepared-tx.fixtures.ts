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
const PREAPPROVAL_SEND_IDS = new Set(["TransferPreapproval_Send", "TransferPreapproval_SendV2"]);

function recordValue(
  fields: Field[],
  positional: boolean,
  blank?: ReadonlySet<string>,
  relabel?: Readonly<Record<string, string>>,
): Uint8Array {
  const record = Writer.create();
  for (const f of fields) {
    const rf = Writer.create();
    // A blanked label is written as "", which is how the wire carries an
    // unlabeled field — Canton reads an empty label as absent.
    if (!positional) rf.uint32(tag(1, WIRE_LEN)).string(blank?.has(f.label) ? "" : (relabel?.[f.label] ?? f.label));
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
  /**
   * The delivery consequence the transfer's choice produces — what says it
   * pays the receiver now rather than leaving a pending instruction.
   *
   * OFF by default, as `factory` is, so every fixture written before the rule
   * keeps the shape it had and the decoder's own tests stay about the transfer.
   * `{}` emits Canton Coin's `TransferPreapproval_SendV2`, which is what a real
   * transfer carries; an object names another registry's choice instead.
   */
  /**
   * A SECOND, independent consequence node beside `delivery` — its own node id,
   * its own disclosed contract. Same shape as `delivery`.
   *
   * The builder could only ever emit one delivery (or the same one twice), so
   * a tree carrying one node of each ARM could not be expressed at all, which
   * is why that whole class went untested.
   */
  second?: EncodeOptions["delivery"];
  /**
   * CREATE nodes the transfer leaves behind, as children of the root. A real
   * one makes several — the merchant's holding, the payer's change — and a
   * forged one signed by the sender alone is the shape this exists to build.
   */
  creates?: readonly {
    signatories: readonly string[];
    moduleName?: string;
    entityName?: string;
  }[];
  delivery?: {
    choiceId?: string;
    moduleName?: string;
    entityName?: string;
    nodeId?: string;
    /** The preapproval's `receiver`. Defaults to the transfer's receiver. */
    receiver?: string;
    /** The preapproval's `dso`. Defaults to the instrument's admin. */
    dso?: string;
    /** The preapproval's `provider`. Defaults to a third party. */
    provider?: string;
    /** Signatories of the disclosure. Defaults to the {dso, receiver, provider} trio. */
    signatories?: readonly string[];
    /** Disclose no input contract for the delivery, so it resolves to nothing. */
    omitDisclosure?: boolean;
    /**
     * Labels to emit blank on the DISCLOSURE's own record (not the choice
     * argument). One blank label puts the whole record in declaration order,
     * which is how a label-keyed reader and the engine come apart.
     */
    blankDisclosureLabels?: readonly string[];
    /** Rewrite a label on the disclosure's record, e.g. `{ receiver: "dso" }`. */
    relabelDisclosure?: Readonly<Record<string, string>>;
    /**
     * What a preapproval send's OWN `amount` says it moves. Defaults to the
     * root's, as an honest one does. A send carries `{context, inputs, amount,
     * sender}` — not a transfer record — which is the shape every real capture
     * carries and the one this fixture emits for a send choice.
     */
    sendAmount?: string;
    /** A second send node, so the delivery is ambiguous. */
    duplicate?: boolean;
    /** Put the delivery under a rollback node: it happened to nobody. */
    rolledBack?: boolean;
    /**
     * What the delivery's own `transfer` record says it moves. Defaults to the
     * root's, as an honest one does; override a field to make the leg that
     * pays disagree with the leg that was signed.
     */
    delivers?: { sender?: string; receiver?: string; amount?: string; instrumentId?: { id: string; admin: string } };
    /** Emit a chosen value that carries no `transfer` record at all. */
    omitDelivers?: boolean;
  };
  /**
   * The choice argument's `expectedAdmin`, the field the on-ledger factory
   * guards on. Defaults to the instrument's admin, as a real transfer carries
   * it; the decoder holds the two equal. `""` leaves the field out entirely.
   */
  expectedAdmin?: string;
  /**
   * `Metadata.submitter_info.act_as`. Defaults to the sender alone, which is
   * what every real capture carries; set it to name other parties, or `[]` to
   * emit none.
   */
  actAs?: readonly string[];
  /**
   * Labels to emit blank, leaving every other field labeled. A record with one
   * blank label is bound positionally by the engine, so this is the shape that
   * tells a label-keyed reader apart from a declaration-order one.
   */
  blankLabels?: readonly string[];
  /**
   * Rewrite a field's label, e.g. `{ receiver: "sender" }` puts the label
   * "sender" on the field declared as `receiver`. Combined with a blank label
   * elsewhere, this is a record the engine binds positionally and whose labels
   * contradict their own positions.
   */
  relabel?: Readonly<Record<string, string>>;
  /**
   * Encode ONE of `InstrumentId`'s values at the wrong type: the admin as Text,
   * or the id as Party. The ledger declares `{admin: Party, id: Text}` and
   * refuses either; a reader that renders party and text alike cannot tell.
   * One field at a time, so each typed read is pinned by its own case.
   */
  miscastInstrument?: "admin" | "id";
  /** Encode the transfer's `amount` as Text, where the ledger declares Numeric. */
  miscastAmount?: boolean;
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
    /**
     * The transaction's `input_contracts`, said outright.
     *
     * Defaults to the one disclosure a real transfer carries: the exercised
     * factory, under the exercise's own template and package name, signed by
     * the instrument's admin. Pass a list to say exactly what is disclosed —
     * none at all, two under one id, a decoy ahead of the real one, or a
     * disclosure that disagrees about the template. Each entry defaults the
     * same way, so a test names only the field it is about.
     *
     * This replaced six booleans. A list of the contracts that exist reads as
     * the case under test; `omitInputContract: true` did not.
     */
    inputContracts?: readonly {
      contractId?: string;
      templateId?: { packageId?: string; moduleName?: string; entityName?: string };
      signatories?: readonly string[];
      packageName?: string;
    }[];
    /** The exercise's `interface_id`. Defaults to the Token Standard factory. */
    interfaceId?: { packageId?: string; moduleName?: string; entityName?: string };
    /** No `interface_id`: the choice was exercised on the template directly. */
    omitInterfaceId?: boolean;
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
  const blank = new Set(opts.blankLabels ?? []);
  const relabel = opts.relabel ?? {};

  // Declaration order is `{admin, id}`, which is what real bytes carry: every
  // MainNet capture and our own LocalNet one put the admin party first. The
  // fixture had them the other way round, agreeing with the decoder's indices
  // rather than with the ledger, so the positional path was only ever read
  // back against the same mistake that wrote it.
  const instrument = recordValue(
    [
      {
        label: "admin",
        value:
          opts.miscastInstrument === "admin"
            ? text(transfer.instrumentId.admin)
            : party(transfer.instrumentId.admin),
      },
      {
        label: "id",
        value:
          opts.miscastInstrument === "id" ? party(transfer.instrumentId.id) : text(transfer.instrumentId.id),
      },
    ],
    positional,
    blank,
    relabel,
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
      { label: "amount", value: opts.miscastAmount ? text(transfer.amount) : numeric(transfer.amount) },
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
              value: recordValue([{ label: "values", value: textMap(memoEntries) }], positional, blank, relabel),
            },
          ]
        : []),
    ],
    positional,
    blank,
    relabel,
  );
  // `expectedAdmin` defaults to the instrument's admin, which is what a real
  // transfer carries. Set it to make the two disagree; "" leaves the field out
  // of the record entirely, which is not the same as an empty party.
  const expectedAdmin = opts.expectedAdmin ?? transfer.instrumentId.admin;
  return recordValue(
    [
      ...(expectedAdmin === ""
        ? []
        : [{ label: "expectedAdmin", value: party(expectedAdmin) }]),
      { label: "transfer", value: transferRecord },
    ],
    positional,
    blank,
    relabel,
  );
}

/**
 * A contract id shaped like a real one: the hasher reads these as HEX
 * (`hexToBytes`), so a readable placeholder makes the fixture unhashable.
 */
const FACTORY_CID = "00f1e2d3c4b5a6978899aabbccddeeff00112233445566778899aabbccddeeff";

/** The exercised factory's id, so a test can name the contract it expects. */
export const EXERCISED_CID = FACTORY_CID;

/** A second disclosure's id, for fixtures that need the match not to be first. */
export const DECOY_CID = "00cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";

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
  /** The disclosure's own record. Defaults to the factory's one-field `{dso}`. */
  argument?: readonly { label: string; value: Uint8Array }[],
  /** Labels to emit blank, which puts the disclosure in declaration order. */
  blankArgLabels?: ReadonlySet<string>,
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
    .bytes(
      recordValue(
        [...(argument ?? [{ label: "dso", value: party(signatories[0] ?? "") }])],
        false,
        blankArgLabels,
      ),
    );
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
  // The delivery consequence, as a child exercise of the transfer. A real
  // transfer carries one; omitting it is the fixture for one that does not,
  // which the verifier refuses.
  const delivery = opts.delivery;
  // Node ids are canonical integers, so the child is the parent's successor —
  // `${nodeId}1` would spell "01" and be refused as non-canonical.
  const nextNodeId = Number.isInteger(Number(nodeId)) ? String(Number(nodeId) + 1) : "1";
  const deliveryNodeId = delivery === undefined ? undefined : (delivery.nodeId ?? nextNodeId);
  // The preapproval the delivery spends: disclosed as an input contract, as a
  // real one is, so the verifier can bind it to the merchant.
  const PREAPPROVAL_CID = "00aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
  const preReceiver = delivery?.receiver ?? transfer.receiver;
  const preDso = delivery?.dso ?? transfer.instrumentId.admin;
  const preProvider = delivery?.provider ?? "app-provider::1220prov";
  const preSignatories = delivery?.signatories ?? [preDso, preReceiver, preProvider];
  const deliveryTemplate = encodeIdentifier({
    moduleName: delivery?.moduleName ?? "Splice.AmuletRules",
    entityName: delivery?.entityName ?? "TransferPreapproval",
  });
  const consequenceExercise = (
    d: EncodeOptions["delivery"],
    cid: string,
    template: Uint8Array,
  ): Uint8Array =>
    wrap(
      3,
      Writer.create()
        .uint32(tag(1, WIRE_LEN))
        .string("2.1")
        .uint32(tag(2, WIRE_LEN))
        .string(cid)
        .uint32(tag(3, WIRE_LEN))
        .string(FACTORY_PACKAGE_NAME)
        .uint32(tag(4, WIRE_LEN))
        .bytes(template)
        .uint32(tag(9, WIRE_LEN))
        .string(d?.choiceId ?? "TransferPreapproval_SendV2")
        // `chosen_value` is not optional to the hasher — an exercise without
        // one is "value is missing". A registry's delivery choice takes the
        // whole Transfer record, and the verifier holds it to the root's, so
        // the fixture carries that shape by default.
        .uint32(tag(10, WIRE_LEN))
        .bytes(
          d?.omitDelivers === true
            ? recordValue([{ label: "note", value: text("no transfer here") }], false)
            : // A preapproval send's argument is `{context, inputs, amount,
              // sender}` — confirmed on all three real Canton Coin captures,
              // where `amount` sits at declaration index 2 and equals the
              // root's. It is NOT transfer-shaped, so `delivers` is absent for
              // it; the fixture emitting a transfer record here would have
              // tested a shape the ledger never produces.
              PREAPPROVAL_SEND_IDS.has(d?.choiceId ?? "TransferPreapproval_SendV2")
              ? recordValue(
                  [
                    { label: "context", value: recordValue([], false) },
                    { label: "inputs", value: emptyList },
                    { label: "amount", value: numeric(d?.sendAmount ?? transfer.amount) },
                    { label: "sender", value: party(transfer.sender) },
                  ],
                  false,
                )
              : recordValue(
            [
              {
                label: "transfer",
                value: recordValue(
                  [
                    { label: "sender", value: party(d?.delivers?.sender ?? transfer.sender) },
                    { label: "receiver", value: party(d?.delivers?.receiver ?? transfer.receiver) },
                    { label: "amount", value: numeric(d?.delivers?.amount ?? transfer.amount) },
                    {
                      label: "instrumentId",
                      // Declaration order {admin, id}, as the root record uses
                      // and as real bytes carry it.
                      value: recordValue(
                        [
                          {
                            label: "admin",
                            value: party(
                              d?.delivers?.instrumentId?.admin ?? transfer.instrumentId.admin,
                            ),
                          },
                          { label: "id", value: text(d?.delivers?.instrumentId?.id ?? transfer.instrumentId.id) },
                        ],
                        false,
                      ),
                    },
                  ],
                  false,
                ),
              },
            ],
            false,
          ),
        )
        .finish(),
    );
  const deliveryNodeIds =
    deliveryNodeId === undefined
      ? []
      : delivery?.duplicate
        ? [deliveryNodeId, String(Number(deliveryNodeId) + 1)]
        : [deliveryNodeId];
  // A rolled-back delivery is reached through a Rollback node, so the walk
  // sees it as rolled back and must not report it as a consequence.
  const rollbackNodeId = delivery?.rolledBack === true ? String(Number(nextNodeId) + 10) : undefined;
  // The second consequence sits two past the first, so it never collides with
  // `duplicate`'s successor id.
  const second = opts.second;
  const SECOND_CID = "00ddeeff00112233445566778899aabbccddeeff00112233445566778899aabb";
  const secondNodeId = second === undefined ? undefined : String(Number(nextNodeId) + 2);
  const secondTemplate = encodeIdentifier({
    moduleName: second?.moduleName ?? "Splice.AmuletRules",
    entityName: second?.entityName ?? "TransferPreapproval",
  });
  const deliveryNodes = [
    ...deliveryNodeIds.map((id) => encodeNode(id, consequenceExercise(delivery, PREAPPROVAL_CID, deliveryTemplate))),
    ...(secondNodeId === undefined
      ? []
      : [encodeNode(secondNodeId, consequenceExercise(second, SECOND_CID, secondTemplate))]),
    ...(rollbackNodeId === undefined
      ? []
      : [
          encodeNode(
            rollbackNodeId,
            wrap(4, deliveryNodeIds.reduce((w, id) => w.uint32(tag(1, WIRE_LEN)).string(id), Writer.create()).finish()),
          ),
        ]),
  ];
  // Create nodes: wire field 1 of a node body, as an exercise is field 3.
  const createSpecs = opts.creates ?? [];
  const createNodeIds = createSpecs.map((_, i) => String(Number(nextNodeId) + 20 + i));
  const createNodes = createSpecs.map((c, i) =>
    encodeNode(
      createNodeIds[i],
      wrap(
        1,
        ((): Uint8Array => {
          const w = Writer.create()
            .uint32(tag(1, WIRE_LEN))
            .string("2.1")
            .uint32(tag(2, WIRE_LEN))
            // HEX only: the hasher reads a contract id with `hexToBytes`, so a
            // readable placeholder makes the fixture unhashable.
            .string(`00cafe${String(i).padStart(2, "0")}${"ab".repeat(28)}`)
            .uint32(tag(3, WIRE_LEN))
            .string(FACTORY_PACKAGE_NAME);
          w.uint32(tag(4, WIRE_LEN)).bytes(
            encodeIdentifier({
              moduleName: c.moduleName ?? "Splice.Amulet",
              entityName: c.entityName ?? "Amulet",
            }),
          );
          // `argument` is not optional to the hasher.
          w.uint32(tag(5, WIRE_LEN)).bytes(
            recordValue([{ label: "owner", value: party(transfer.sender) }], false),
          );
          for (const sig of c.signatories) w.uint32(tag(6, WIRE_LEN)).string(sig);
          return w.finish();
        })(),
      ),
    ),
  );
  const childIds = [
    ...(rollbackNodeId === undefined ? deliveryNodeIds : [rollbackNodeId]),
    ...(secondNodeId === undefined ? [] : [secondNodeId]),
    ...createNodeIds,
  ];
  const exerciseWithChild = childIds.reduce(
    (acc, id) => concat(acc, Writer.create().uint32(tag(12, WIRE_LEN)).string(id).finish()),
    exerciseBytes,
  );
  const v1Node = concat(wrap(3, concat(exerciseWithChild, extra.exercise)), extra.node);
  const damlNode = concat(encodeNode(nodeId, v1Node), extra.damlNode);

  // One seed per EXERCISE node: the hasher refuses a tree where an exercise
  // has none, and the delivery consequence is an exercise too.
  const seedFor = (id: string, fill: number): Uint8Array =>
    Writer.create()
      .uint32(tag(1, 0))
      .int32(Number(id))
      .uint32(tag(2, WIRE_LEN))
      .bytes(new Uint8Array(32).fill(fill))
      .finish();

  const damlTxn = Writer.create()
    .uint32(tag(1, WIRE_LEN))
    .string("2.1");

  for (const root of opts.roots ?? [nodeId]) {
    damlTxn.uint32(tag(2, WIRE_LEN)).string(root);
  }

  for (const node of [damlNode, ...deliveryNodes, ...createNodes, ...(opts.nodes ?? [])]) {
    damlTxn.uint32(tag(3, WIRE_LEN)).bytes(node);
  }

  for (const seed of [
    seedFor(nodeId, 1),
    ...deliveryNodeIds.map((id, i) => seedFor(id, 2 + i)),
    // The second consequence is an exercise too, and the hasher refuses a tree
    // where one has no seed — without this the blob is rejected before any
    // check runs, and a test would pass for the wrong reason.
    ...(secondNodeId === undefined ? [] : [seedFor(secondNodeId, 9)]),
    // A CREATE needs a seed too — the hasher refuses "create node N has no
    // seed" exactly as it does for an exercise.
    ...createNodeIds.map((id, i) => seedFor(id, 20 + i)),
  ]) {
    damlTxn.uint32(tag(4, WIRE_LEN)).bytes(seed);
  }

  // `act_as` defaults to the sender alone, as a real submission carries it.
  // `actAs: []` emits none; a list emits exactly those parties.
  const submitter = Writer.create();
  for (const party of opts.actAs ?? [transfer.sender]) {
    submitter.uint32(tag(1, WIRE_LEN)).string(party);
  }
  const submitterInfo = submitter.uint32(tag(2, WIRE_LEN)).string("test-command").finish();

  const metadata = Writer.create()
    .uint32(tag(2, WIRE_LEN))
    .bytes(submitterInfo)
    .uint32(tag(3, WIRE_LEN))
    // What Canton signs: the PHYSICAL id. A fixture that passes none gets the
    // logical id the requirements fixtures quote, so the pin matches.
    .string(transfer.synchronizerId ?? "global-domain::1220be58c29e")
    .uint32(tag(5, WIRE_LEN))
    .string("test-transaction");
  if (factory) {
    // One disclosure by default: the exercised factory, agreeing with the
    // exercise about what it is and signed by the instrument's admin.
    const disclosures = factory.inputContracts ?? [{}];
    for (const d of disclosures) {
      metadata.uint32(tag(7, WIRE_LEN)).bytes(
        encodeInputContract(
          d.contractId ?? factory.contractId ?? FACTORY_CID,
          encodeIdentifier(d.templateId ?? factory.templateId),
          d.signatories ?? [transfer.instrumentId.admin],
          d.packageName ?? FACTORY_PACKAGE_NAME,
        ),
      );
    }
  }
  // The preapproval the delivery spends, disclosed as a real one is: its
  // record names the trio, and the verifier reads the receiver out of it.
  if (delivery !== undefined && !delivery.omitDisclosure) {
    metadata.uint32(tag(7, WIRE_LEN)).bytes(
      encodeInputContract(
        PREAPPROVAL_CID,
        deliveryTemplate,
        preSignatories,
        FACTORY_PACKAGE_NAME,
        [
          { label: delivery.relabelDisclosure?.dso ?? "dso", value: party(preDso) },
          { label: delivery.relabelDisclosure?.receiver ?? "receiver", value: party(preReceiver) },
          { label: delivery.relabelDisclosure?.provider ?? "provider", value: party(preProvider) },
        ],
        new Set(delivery.blankDisclosureLabels ?? []),
      ),
    );
  }
  if (second !== undefined && !second.omitDisclosure) {
    metadata.uint32(tag(7, WIRE_LEN)).bytes(
      encodeInputContract(SECOND_CID, secondTemplate, second.signatories ?? [
        second.dso ?? transfer.instrumentId.admin,
        second.receiver ?? transfer.receiver,
        second.provider ?? "app-provider::1220prov",
      ], FACTORY_PACKAGE_NAME, [
        { label: "dso", value: party(second.dso ?? transfer.instrumentId.admin) },
        { label: "receiver", value: party(second.receiver ?? transfer.receiver) },
        { label: "provider", value: party(second.provider ?? "app-provider::1220prov") },
      ]),
    );
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
