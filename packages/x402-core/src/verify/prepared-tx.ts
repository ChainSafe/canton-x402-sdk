// The transfer a Canton interactive-submission `PreparedTransaction` authorizes,
// read so the verifier can bind it to the requirements (a signed payload must
// move what the requirements ask for, not something else).
//
// Decoded by @canton-network/core-tx-visualizer, which is the SAME decode the
// signing hash is taken over: `hashPreparedTransaction` calls
// `decodePreparedTransaction` and hashes the resulting tree, not the bytes. So
// what is read here is what the payer's signature commits to. A second parser
// would be a second reading of one blob, and the attacker's win condition is
// making two readings disagree.
//
// Wire-level canonicality is therefore not checked here: non-canonical bytes
// reach the hasher through the same parse, so they change the hash and fail the
// signature rather than changing what this reads. What IS checked is the shape
// of the transaction, which the hash does not constrain.
//
// SPDX-License-Identifier: Apache-2.0

import { decodePreparedTransaction as decodeVendorPreparedTransaction } from "@canton-network/core-tx-visualizer";
import { canonicalNodeId } from "./prepared-tx-guard";

/**
 * The transfer a prepared transaction authorizes, decoded out of the opaque
 * `preparedTransaction` blob. Checked against the requirements by the verifier.
 */
export interface DecodedTransfer {
  /** Paying party: the payment's payer (spec Rule 8), since the payload names none. */
  sender: string;
  /** Receiving party — must equal `requirements.payTo`. */
  receiver: string;
  /** On-ledger `Decimal`. Equals `requirements.amount` once converted from atomic units. */
  amount: string;
  /** Instrument moved — must equal `requirements.extra.instrumentId`. */
  instrumentId: { id: string; admin: string };
  /**
   * `executeBefore` as Daml `Time` — microseconds since the epoch. The transfer
   * is unexecutable after it, so Rule 10 refuses one that is not still ahead of
   * now by a margin. Microseconds, not milliseconds, and `bigint` because the
   * value is a 64-bit integer the wire carries exactly.
   */
  executeBeforeMicros?: bigint;
  /** `meta.values["x402.memo"]`, when the payer committed one (Rule 12). */
  memo?: string;
  /**
   * `Metadata.synchronizer_id` — the domain this transaction is prepared for,
   * read from the signed block, so the payer committed to it rather than a
   * relay choosing it.
   *
   * EITHER form may appear. Canton signs the LOGICAL id a merchant quotes on
   * the releases LocalNet runs; newer ones sign the PHYSICAL id, which is that
   * plus `::<protocol-version>-<serial>`. Both parts are the synchronizer's
   * own — the protocol version is fixed when it is initialised, the serial
   * steps on a logical upgrade — not anything a participant picks.
   * {@link synchronizerMatches} takes either.
   */
  synchronizerId?: string;
  /**
   * The contract the transfer's exercise targets, resolved against the
   * transaction's own `input_contracts` — the evidence the real-factory
   * proof is decided on.
   *
   * Present only when the exercised contract id names exactly ONE input
   * contract that agrees with the exercise about what it is. Absent means the
   * transaction carries no usable proof of what it exercised, which the
   * verifier refuses; it is not the same as the blob being undecodable, so the
   * two stay distinguishable.
   *
   * Everything here is covered by the signing hash. `eventBlob` is NOT, so it
   * is deliberately absent: a decision read off it would be a decision nobody
   * signed.
   */
  exercisedContract?: {
    /**
     * Kept though nothing here reads it: it is the handle a caller holding a
     * registry needs to check the contract against one, which is the part of
     * this proof that cannot be done from the blob alone.
     */
    contractId: string;
    signatories: readonly string[];
    /**
     * The interface the exercised choice was inherited from, absent when the
     * choice is the template's own. A Token Standard transfer is exercised
     * through `TransferFactory`, so this is what says which kind of transfer
     * this is, independently of whose registry implements it.
     */
    interfaceId?: { packageId: string; moduleName: string; entityName: string };
  };
}

/**
 * The metadata key the scheme reserves for the merchant's memo (Rule 12).
 *
 * Exported because the payer that WRITES it and the verifier that READS it
 * have to name the same key, and two spellings of a string agree only by
 * luck. The fixtures keep the literal on purpose: something has to pin the
 * wire value, and a test written in terms of this constant would follow it
 * wherever it went.
 */
export const MEMO_KEY = "x402.memo";

const TRANSFER_CHOICE = "TransferFactory_Transfer";

type Vendor = ReturnType<typeof decodeVendorPreparedTransaction>;
type VendorNode = NonNullable<Vendor["transaction"]>["nodes"][number];
/** A Daml `Value` as the vendor types it: a `sum` oneof. */
type VendorValue = { sum: { oneofKind: string } & Record<string, unknown> };
type VendorField = { label: string; value?: VendorValue };
type VendorIdentifier = { packageId: string; moduleName: string; entityName: string };
type VendorCreate = {
  contractId: string;
  packageName: string;
  templateId?: VendorIdentifier;
  signatories: string[];
};
type VendorInputContract = { contract: { oneofKind?: string; v1?: VendorCreate } };

/**
 * Pick a record field by label, falling back to positional index. A Daml LF
 * record is encoded either fully-labeled or fully-positional (proto rule), so we
 * detect which and use the matching strategy. The positional order mirrors the
 * choice/record's Daml declaration order.
 */
function pick(fields: readonly VendorField[], label: string, index: number): VendorValue | undefined {
  const labeled = fields.some((f) => f.label !== "");
  return labeled ? fields.find((f) => f.label === label)?.value : fields[index]?.value;
}

/** A scalar the walker reads as a string: party, text or numeric are all strings on the wire. */
function str(value: VendorValue | undefined): string | undefined {
  const sum = value?.sum;
  if (!sum) return undefined;
  if (sum.oneofKind === "party") return sum.party as string;
  if (sum.oneofKind === "text") return sum.text as string;
  if (sum.oneofKind === "numeric") return sum.numeric as string;
  return undefined;
}

function fieldsOf(value: VendorValue | undefined): readonly VendorField[] | undefined {
  const sum = value?.sum;
  if (sum?.oneofKind !== "record") return undefined;
  return (sum.record as { fields: VendorField[] }).fields;
}

/** Daml `Time`, carried as a decimal string (jstype JS_STRING) and widened back to the 64-bit value. */
function micros(value: VendorValue | undefined): bigint | undefined {
  const sum = value?.sum;
  if (sum?.oneofKind !== "timestamp") return undefined;
  return BigInt(sum.timestamp as string);
}

/**
 * A TextMap's entries as a map. A repeated key is refused rather than resolved:
 * one of them would win here and the other at the ledger, and a quoted memo is
 * part of what the payer signs.
 */
function textMap(value: VendorValue | undefined): Map<string, VendorValue | undefined> | undefined {
  const sum = value?.sum;
  if (sum?.oneofKind !== "textMap") return undefined;
  const out = new Map<string, VendorValue | undefined>();
  for (const entry of (sum.textMap as { entries: { key: string; value?: VendorValue }[] }).entries) {
    if (out.has(entry.key)) throw new Error(`text map repeats the key ${entry.key}`);
    out.set(entry.key, entry.value);
  }
  return out;
}

/** Read the TransferFactory_Transfer argument record `{ expectedAdmin, transfer }`. */
function readTransfer(chosenValue: VendorValue | undefined): DecodedTransfer | null {
  const arg = fieldsOf(chosenValue);
  if (!arg) return null;
  const transfer = fieldsOf(pick(arg, "transfer", 1));
  if (!transfer) return null;

  const sender = str(pick(transfer, "sender", 0));
  const receiver = str(pick(transfer, "receiver", 1));
  const amount = str(pick(transfer, "amount", 2));
  const instr = fieldsOf(pick(transfer, "instrumentId", 3));
  const id = instr && str(pick(instr, "id", 0));
  const admin = instr && str(pick(instr, "admin", 1));
  // Declaration order after the four above: requestedAt, executeBefore,
  // inputHoldingCids, meta.
  const executeBeforeMicros = micros(pick(transfer, "executeBefore", 5));
  // `meta` is a Metadata RECORD whose single field `values` holds the TextMap —
  // not a TextMap directly.
  const meta = fieldsOf(pick(transfer, "meta", 7));
  const memo = meta && str(textMap(pick(meta, "values", 0))?.get(MEMO_KEY));

  if (!sender || !receiver || !amount || !id || !admin) return null;
  return { sender, receiver, amount, instrumentId: { id, admin }, executeBeforeMicros, memo };
}

/**
 * Two template identifiers naming the same Daml template.
 *
 * The package id is NOT compared. An exercise's `template_id` names the package
 * the choice was resolved against, which the payer's participant picks by
 * package NAME; the input contract's names the package its contract was created
 * under. Canton documents that the two differ once a contract has been upgraded
 * or downgraded, so requiring them equal would refuse honest payments for the
 * whole window of a Splice rollout. Name, module and entity are what an upgrade
 * preserves, and `resolveExercised` pairs this with the package name.
 */
function sameTemplate(a: VendorIdentifier | undefined, b: VendorIdentifier | undefined): boolean {
  if (!a || !b) return false;
  return a.moduleName === b.moduleName && a.entityName === b.entityName;
}

/**
 * The contract an exercise targets, found among the transaction's input
 * contracts — every contract it uses but does not create, carried with its
 * template and signatories and covered by the payer's signature.
 *
 * EXACTLY ONE match, not the first: a repeated entry would let a payer put two
 * contracts under one id and have the reader pick while the ledger picks the
 * other. An exercise naming no contract resolves to nothing — the id decodes as
 * "" when absent, so matching it would find an entry that is equally blank.
 *
 * The exercise and the disclosure must agree on what the contract IS — same
 * package name, same module, same entity — because a transaction that says two
 * different things about one contract is not one to read further. They need not
 * agree on the package id; see `sameTemplate`.
 */
function resolveExercised(
  exercise: { contractId?: string; packageName?: string; templateId?: VendorIdentifier; interfaceId?: VendorIdentifier },
  inputContracts: readonly VendorInputContract[],
): DecodedTransfer["exercisedContract"] | undefined {
  const contractId = exercise.contractId;
  if (!contractId) return undefined;
  const matches = inputContracts.filter(
    (ic) => ic.contract.oneofKind === "v1" && ic.contract.v1?.contractId === contractId,
  );
  if (matches.length !== 1) return undefined;
  const create = matches[0].contract.v1;
  if (!create?.templateId || !sameTemplate(create.templateId, exercise.templateId)) return undefined;
  if (create.packageName !== exercise.packageName) return undefined;
  return {
    contractId: create.contractId,
    signatories: create.signatories,
    ...(exercise.interfaceId === undefined ? {} : { interfaceId: exercise.interfaceId }),
  };
}

/** The node's single body: exercise, rollback, or something that moves nothing. */
function bodyOf(node: VendorNode): { kind: string; body: Record<string, unknown> } | null {
  const versioned = node.versionedNode;
  if (versioned.oneofKind !== "v1") return null;
  const nodeType = versioned.v1.nodeType as { oneofKind?: string } & Record<string, unknown>;
  if (!nodeType.oneofKind) return null;
  return { kind: nodeType.oneofKind, body: nodeType[nodeType.oneofKind] as Record<string, unknown> };
}

/**
 * Decode the `preparedTransaction` blob (base64) into the transfer it authorizes,
 * or `null` if it can't be decoded or contains no `TransferFactory_Transfer`
 * exercise. Never throws — an undecodable blob is treated as "no proof of a
 * matching transfer" and rejected upstream.
 */
export function decodePreparedTransaction(preparedTransactionBase64: string): DecodedTransfer | null {
  try {
    // `throw`, not the default `true`: an unknown field is a field the signing
    // hash does not cover, and reading past it would bind the requirements to a
    // transaction carrying bytes nobody signed. The hasher refuses the same
    // input, so this only moves the refusal earlier and names it better.
    const decoded = decodeVendorPreparedTransaction(preparedTransactionBase64, {
      readUnknownField: "throw",
    });
    const txn = decoded.transaction;
    if (!txn) return null;
    // protobuf-ts types this `string`, defaulting to "", so an absent Metadata
    // field and one written empty arrive the same way — the walker could tell
    // them apart and this cannot. Absent is the real case and an empty id
    // matches no quoted synchronizer, so both are read as "none given".
    const synchronizerId = decoded.metadata?.synchronizerId || undefined;

    // Canton parses node ids as integers and refuses nodes the roots cannot
    // reach, and the signed hash covers only the tree under the roots. So read
    // exactly that tree, with ids spelled the one way Canton reads them.
    const nodes = new Map<string, VendorNode>();
    for (const node of txn.nodes) {
      const nodeId = canonicalNodeId(node.nodeId);
      if (nodes.has(nodeId)) throw new Error(`node ${nodeId} is repeated`);
      nodes.set(nodeId, node);
    }

    const reached = new Set<string>();
    const stack: { nodeId: string; rolledBack: boolean }[] = [];
    const reach = (ids: readonly string[], rolledBack: boolean): void => {
      // Pushed in reverse so nodes are visited in the order the tree lists them.
      for (const nodeId of [...ids].reverse()) {
        if (reached.has(nodeId)) throw new Error(`node ${nodeId} is referenced twice`);
        reached.add(nodeId);
        stack.push({ nodeId, rolledBack });
      }
    };
    // ONE ROOT, AND IT IS THE TRANSFER. A payment is a single command, so its
    // transaction is a single tree whose root is the transfer being paid for.
    // Allowing the transfer to sit beside or beneath anything else would let a
    // payer attach legs the facilitator relays, and pays the traffic fee for,
    // without ever having verified them. Consequences of the transfer — the
    // children its own choice produces — are not that, and still decode.
    if (txn.roots.length !== 1) {
      throw new Error(`transaction declares ${txn.roots.length} roots, expected 1`);
    }
    reach(txn.roots, false);

    let transferArg: VendorValue | undefined; // the root TransferFactory_Transfer's chosen_value
    let exercised: DecodedTransfer["exercisedContract"];
    for (let next = stack.pop(); next; next = stack.pop()) {
      const node = nodes.get(next.nodeId);
      if (!node) throw new Error(`node ${next.nodeId} is missing`);
      const body = bodyOf(node);
      if (!body) continue;
      if (body.kind === "rollback") {
        reach((body.body as { children: string[] }).children, true);
        continue;
      }
      if (body.kind !== "exercise") continue;

      const exercise = body.body as {
        choiceId: string;
        chosenValue?: VendorValue;
        children: string[];
        contractId?: string;
        packageName?: string;
        templateId?: VendorIdentifier;
        interfaceId?: VendorIdentifier;
      };
      reach(exercise.children, next.rolledBack);
      if (exercise.choiceId !== TRANSFER_CHOICE) continue;
      // A transfer under a rollback node moves nothing.
      if (next.rolledBack) throw new Error("transfer under a rollback node");
      // The transfer IS the root, so there is exactly one of it. Canton runs
      // every transfer in the tree; reporting one of several would describe a
      // payment the caller never made, binding the requirements to one leg and
      // letting the rest through unchecked.
      // Against the raw root reference, as the walker compared it: ids are
      // canonicalised where a node is DEFINED, so a non-canonical reference
      // resolves to no node and is refused as missing rather than here.
      if (next.nodeId !== txn.roots[0]) {
        throw new Error("the transfer is not the transaction's root");
      }
      transferArg = exercise.chosenValue;
      exercised = resolveExercised(exercise, decoded.metadata?.inputContracts ?? []);
    }
    if (reached.size !== nodes.size) throw new Error("a node is not reachable from the roots");

    const transfer = transferArg ? readTransfer(transferArg) : null;
    if (!transfer) return null;
    return {
      ...transfer,
      ...(synchronizerId === undefined ? {} : { synchronizerId }),
      ...(exercised === undefined ? {} : { exercisedContract: exercised }),
    };
  } catch {
    return null;
  }
}
