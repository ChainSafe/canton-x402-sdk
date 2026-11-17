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
// Wire-level canonicality is not checked here, and the hash does not check it
// either: `hashPreparedTransaction` re-serialises the decoded tree before
// hashing, so non-canonical bytes hash exactly like their canonical form. That
// is harmless for the two readings above — both read the same tree — but it
// means a blob protobuf-java reads DIFFERENTLY still hashes the same here.
// Canton's own hash then differs and it refuses the signature at execution, so
// such a payload verifies and fails to settle. Re-serialising the decode and
// comparing it to the input bytes would catch that earlier — a real prepare
// vector round-trips exactly — but the vendor package exports only its three
// functions, not the message type `toBinary` lives on, and its `exports` map
// has no deep path. It needs an upstream export.
//
// What IS checked here is the shape of the transaction, which the hash does
// not constrain at all.
//
// SPDX-License-Identifier: Apache-2.0

import { decodePreparedTransaction as decodeVendorPreparedTransaction } from "@canton-network/core-tx-visualizer";
import { canonicalNodeId } from "./prepared-tx-guard";
import { recordField, sameTemplate } from "./record-fields";

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
  /**
   * Every OTHER exercise in the transaction — the consequences the transfer's
   * own choice produced, in the order the tree lists them.
   *
   * What a transfer does is not said by its arguments alone. The same signed
   * `TransferFactory_Transfer` either delivers to the receiver in one step or
   * creates a pending instruction the payer can later withdraw, and which of
   * those happened is visible only here. A caller reading this decides; the
   * decoder names no choice, so a registry's own delivery choice needs no
   * change down here.
   *
   * Excludes the root transfer itself, and anything under a rollback — a
   * rolled-back consequence happened to nobody.
   *
   * Absent when the transfer produced none, as the other optional members are.
   * A reader treats absent and empty alike: either way nothing was delivered
   * that this can see.
   */
  consequences?: readonly {
    choiceId: string;
    templateId: { packageId: string; moduleName: string; entityName: string };
    /** A consuming exercise archives its contract; a holding spent says so. */
    consuming: boolean;
    /**
     * The disclosed contract this consequence exercises, resolved the same way
     * the root's is — present only when the id names exactly one input contract
     * that agrees with the exercise about what it is.
     *
     * `argument` is the disclosure's own record, scalar leaves only, in
     * declaration order with whatever labels it carried. A reader names the
     * fields it wants; the decoder names none, so a registry whose contract
     * holds different fields needs no change here.
     */
    target?: {
      contractId: string;
      signatories: readonly string[];
      argument: readonly { label: string; value?: string }[];
    };
    /**
     * The transfer this consequence carries in its own choice argument, when
     * it carries one.
     *
     * A registry's delivery choice takes the whole `Transfer` record as its
     * argument, so what it moves is readable here and can be held to what the
     * root said it would move. Absent when the argument is not shaped that
     * way, which is most consequences.
     */
    delivers?: Pick<DecodedTransfer, "sender" | "receiver" | "amount" | "instrumentId">;
    /**
     * The consequence's OWN choice argument, scalar leaves only, in declaration
     * order with whatever labels it carried.
     *
     * Not to be confused with `target.argument`, which is the DISCLOSED
     * CONTRACT's record. This is what the choice was called with. Canton Coin's
     * `TransferPreapproval_SendV2` carries its amount here and nowhere else —
     * its argument is `{context, inputs, amount, sender}`, which is not
     * transfer-shaped, so `delivers` is absent for it and a reader with only
     * `delivers` could not tell a dust send from an honest one.
     *
     * The decoder names no field; a reader names the ones it wants.
     */
    chosenArgument?: readonly { label: string; value?: string }[];
  }[];
  /**
   * Every CREATE the transaction makes, in the order the tree lists them.
   *
   * The consequences say which choices ran; these say what they left behind.
   * The money a transfer moves lands in creates — on Canton Coin, one `Amulet`
   * for the merchant and one for the payer's change — so a reader that sees
   * only exercises never sees the payment itself.
   *
   * They matter because a contract the SENDER signs carries the sender's
   * authority into whatever choices it offers. The reference implementation
   * reports measuring this: a create signed by the sender alone, bolted onto
   * the captured Canton Coin and USDCx payments, passed every other check.
   *
   * Excludes anything under a rollback, as `consequences` does.
   */
  creates?: readonly {
    contractId: string;
    templateId: { packageId: string; moduleName: string; entityName: string };
    signatories: readonly string[];
  }[];
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
  /** Loose: the vendor's own `Value` union does not narrow to {@link VendorValue}. */
  argument?: unknown;
};
type VendorInputContract = { contract: { oneofKind?: string; v1?: VendorCreate } };

/**
 * Scalars read AT their declared type.
 *
 * One reader that took party, text and numeric alike could not tell a Party
 * from a Text, so a record written as `[party("Amulet"), text("DSO::...")]`
 * read back as a well-formed instrument whose admin was the DSO. The ledger
 * binds `InstrumentId` as `{admin: Party, id: Text}` and refuses that blob;
 * reading each field at its declared type refuses it here instead.
 */
function partyOf(value: VendorValue | undefined): string | undefined {
  const sum = value?.sum;
  return sum?.oneofKind === "party" ? (sum.party as string) : undefined;
}

function textOf(value: VendorValue | undefined): string | undefined {
  const sum = value?.sum;
  return sum?.oneofKind === "text" ? (sum.text as string) : undefined;
}

function numericOf(value: VendorValue | undefined): string | undefined {
  const sum = value?.sum;
  return sum?.oneofKind === "numeric" ? (sum.numeric as string) : undefined;
}

/**
 * Any scalar leaf as a string, for ENUMERATING a record whose shape we do not
 * know. There is no declared type to read it at, so permissiveness is the point
 * here — unlike `partyOf`/`textOf`/`numericOf`, which exist because reading a
 * DECLARED field permissively let a party stand in for a text. Do not reach for
 * this one where the field's type is known.
 */
function anyScalar(value: VendorValue | undefined): string | undefined {
  const sum = value?.sum;
  if (!sum) return undefined;
  if (sum.oneofKind === "party") return sum.party as string;
  if (sum.oneofKind === "text") return sum.text as string;
  if (sum.oneofKind === "numeric") return sum.numeric as string;
  return undefined;
}


/**
 * A record's fields — refusing one whose labels repeat.
 *
 * Two copies of a MESSAGE field do not last-wins like a scalar: protobuf
 * merges them, and merging concatenates their repeated members. A chosen value
 * written twice therefore decodes as ONE record carrying both sets of fields,
 * and reading the first while the signature covers both is exactly the
 * two-readings-of-one-blob this decoder exists to prevent. A Daml record's
 * labels are distinct by construction, so refusing a repeat costs nothing
 * honest.
 *
 * Only the labeled form is caught. A fully-positional record doubled the same
 * way concatenates into indices nothing can tell apart from a wider record —
 * the ledger should refuse it on arity, but that is its check and not ours.
 * Canton labels what it enriches, so real payloads take the labeled path.
 */
function fieldsOf(value: VendorValue | undefined): readonly VendorField[] | undefined {
  const sum = value?.sum;
  if (sum?.oneofKind !== "record") return undefined;
  const fields = (sum.record as { fields: VendorField[] }).fields;
  const labels = fields.map((f) => f.label).filter((label) => label !== "");
  if (new Set(labels).size !== labels.length) return undefined;
  return fields;
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

/**
 * The money-carrying fields of a Token Standard `Transfer` record.
 *
 * Shared, because the same record appears twice in one transaction: once as
 * the root choice's argument, and again inside a registry's delivery
 * consequence. Reading both with one function is what lets the two be compared
 * without a second idea of what a transfer is.
 */
function readTransferRecord(
  transfer: readonly VendorField[],
): Pick<DecodedTransfer, "sender" | "receiver" | "amount" | "instrumentId"> | null {
  const sender = partyOf(recordField(transfer, "sender", 0));
  const receiver = partyOf(recordField(transfer, "receiver", 1));
  const amount = numericOf(recordField(transfer, "amount", 2));
  const instr = fieldsOf(recordField(transfer, "instrumentId", 3));
  const id = instr && textOf(recordField(instr, "id", 1));
  const admin = instr && partyOf(recordField(instr, "admin", 0));
  if (!sender || !receiver || !amount || !id || !admin) return null;
  return { sender, receiver, amount, instrumentId: { id, admin } };
}

/** The `transfer` record a registry's delivery consequence carries, if it does. */
function readDelivered(
  chosenValue: VendorValue | undefined,
): NonNullable<DecodedTransfer["consequences"]>[number]["delivers"] {
  const arg = fieldsOf(chosenValue);
  if (!arg) return undefined;
  const transfer = fieldsOf(recordField(arg, "transfer", 0));
  if (!transfer) return undefined;
  return readTransferRecord(transfer) ?? undefined;
}

/**
 * Read the TransferFactory_Transfer argument record `{ expectedAdmin, transfer }`.
 *
 * `expectedAdmin` names the FACTORY's admin — the Token Standard has the
 * factory validate it against its own — while `instrumentId.admin` names the
 * registry that administers the INSTRUMENT. Different things, and the standard
 * does not require them equal.
 *
 * We require it anyway. `TransferFactoryView.admin` is "the party representing
 * the registry app that administers the instruments for which this transfer
 * factory can be used", so for a well-formed registry they are one party, and
 * the real Canton Coin payment carries the DSO in both. The factory check in
 * `canton-exact.ts` already rests on the same assumption, demanding the
 * exercised contract be signed by `instrumentId.admin`. A registry that split
 * the two parties would fail both checks together, which is the one thing to
 * look at first if an honest non-Amulet transfer is ever refused here.
 *
 * What it buys: `expectedAdmin` is what the ledger guards on, so pinning it to
 * an admin a facilitator has pinned to the real DSO means a transfer aimed at
 * another issuer's factory is refused at verify rather than at execution.
 */
function readTransfer(chosenValue: VendorValue | undefined): DecodedTransfer | null {
  const arg = fieldsOf(chosenValue);
  if (!arg) return null;
  const expectedAdmin = partyOf(recordField(arg, "expectedAdmin", 0));
  const transfer = fieldsOf(recordField(arg, "transfer", 1));
  if (!transfer) return null;

  const money = readTransferRecord(transfer);
  const sender = money?.sender;
  const receiver = money?.receiver;
  const amount = money?.amount;
  const id = money?.instrumentId.id;
  const admin = money?.instrumentId.admin;
  // Declaration order after the four above: requestedAt, executeBefore,
  // inputHoldingCids, meta.
  const executeBeforeMicros = micros(recordField(transfer, "executeBefore", 5));
  // `meta` is a Metadata RECORD whose single field `values` holds the TextMap —
  // not a TextMap directly.
  const meta = fieldsOf(recordField(transfer, "meta", 7));
  const memo = meta && textOf(textMap(recordField(meta, "values", 0))?.get(MEMO_KEY));

  if (!sender || !receiver || !amount || !id || !admin) return null;
  if (!expectedAdmin || expectedAdmin !== admin) return null;
  return { sender, receiver, amount, instrumentId: { id, admin }, executeBeforeMicros, memo };
}


/**
 * A record's leaves as strings, in declaration order with the labels it
 * carried.
 *
 * Only party, text and numeric read as a value. A record, a list, a timestamp
 * — anything {@link str} does not render — reads as a field with no value,
 * which keeps its position so a reader matching by index still lines up, but
 * does NOT distinguish "not a scalar" from "a scalar of a kind not rendered".
 * A reader that needs one of those has to decode it itself.
 *
 * The decoder names no field, so what a given contract means by them is the
 * reader's.
 */
function scalarFields(value: VendorValue | undefined): readonly { label: string; value?: string }[] {
  const fields = fieldsOf(value);
  if (!fields) return [];
  return fields.map((f) => {
    const leaf = anyScalar(f.value);
    return leaf === undefined ? { label: f.label } : { label: f.label, value: leaf };
  });
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
 *
 * Shared by the root transfer and its consequences: the same question — which
 * input contract is this, and do the two agree about what it is — and the same
 * refusals, so a consequence cannot be bound on looser terms than the factory.
 */
function resolveTarget(
  exercise: { contractId?: string; packageName?: string; templateId?: VendorIdentifier },
  inputContracts: readonly VendorInputContract[],
): { create: VendorCreate } | undefined {
  const contractId = exercise.contractId;
  if (!contractId) return undefined;
  const matches = inputContracts.filter(
    (ic) => ic.contract.oneofKind === "v1" && ic.contract.v1?.contractId === contractId,
  );
  if (matches.length !== 1) return undefined;
  const create = matches[0].contract.v1;
  if (!create?.templateId || !sameTemplate(create.templateId, exercise.templateId)) return undefined;
  if (create.packageName !== exercise.packageName) return undefined;
  return { create };
}

function resolveExercised(
  exercise: { contractId?: string; packageName?: string; templateId?: VendorIdentifier; interfaceId?: VendorIdentifier },
  inputContracts: readonly VendorInputContract[],
): DecodedTransfer["exercisedContract"] | undefined {
  const resolved = resolveTarget(exercise, inputContracts);
  if (!resolved) return undefined;
  return {
    contractId: resolved.create.contractId,
    signatories: resolved.create.signatories,
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
    const actAs = decoded.metadata?.submitterInfo?.actAs ?? [];

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
    const consequences: NonNullable<DecodedTransfer["consequences"]>[number][] = [];
    const creates: NonNullable<DecodedTransfer["creates"]>[number][] = [];
    for (let next = stack.pop(); next; next = stack.pop()) {
      const node = nodes.get(next.nodeId);
      if (!node) throw new Error(`node ${next.nodeId} is missing`);
      const body = bodyOf(node);
      if (!body) continue;
      if (body.kind === "rollback") {
        reach((body.body as { children: string[] }).children, true);
        continue;
      }
      if (body.kind === "create") {
        // A rolled-back create left nothing behind, as a rolled-back
        // consequence happened to nobody.
        if (!next.rolledBack) {
          const made = body.body as {
            contractId?: string;
            templateId?: VendorIdentifier;
            signatories?: string[];
          };
          if (made.templateId) {
            creates.push({
              contractId: made.contractId ?? "",
              templateId: made.templateId,
              signatories: made.signatories ?? [],
            });
          }
        }
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
        consuming?: boolean;
      };
      reach(exercise.children, next.rolledBack);
      if (exercise.choiceId !== TRANSFER_CHOICE) {
        // A rolled-back consequence happened to nobody, so it is not reported
        // as one; the node still has to be reachable, which `reach` above did.
        if (!next.rolledBack && exercise.templateId) {
          const resolved = resolveTarget(exercise, decoded.metadata?.inputContracts ?? []);
          const delivered = readDelivered(exercise.chosenValue);
          consequences.push({
            choiceId: exercise.choiceId,
            templateId: exercise.templateId,
            consuming: exercise.consuming === true,
            ...(delivered === undefined ? {} : { delivers: delivered }),
            chosenArgument: scalarFields(exercise.chosenValue),
            ...(resolved === undefined
              ? {}
              : {
                  target: {
                    contractId: resolved.create.contractId,
                    signatories: resolved.create.signatories,
                    argument: scalarFields(resolved.create.argument as VendorValue | undefined),
                  },
                }),
          });
        }
        continue;
      }
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
    // THE SUBMITTER IS THE SENDER, and nobody else.
    //
    // `Metadata.submitter_info.act_as` names the parties the submission acts
    // for. It sits in the signing preimage, so the payer chooses it and
    // commits to it, but nothing in the choice argument constrains it: a
    // transfer that moves the sender's money can name any party at all as a
    // co-submitter, a facilitator's own party included. That grants AUTHORITY
    // rather than describing the transfer, which is why it is not enough to
    // read the transfer and stop.
    //
    // Refused here rather than in the verifier because it is a statement about
    // the blob alone — two signed fields that have to agree — which is where
    // `expectedAdmin` is held too. An empty list is refused with them: it is
    // not "no claim", it is a submission with no proven submitter.
    if (actAs.length !== 1 || actAs[0] !== transfer.sender) return null;
    return {
      ...transfer,
      ...(synchronizerId === undefined ? {} : { synchronizerId }),
      ...(exercised === undefined ? {} : { exercisedContract: exercised }),
      ...(consequences.length === 0 ? {} : { consequences }),
      ...(creates.length === 0 ? {} : { creates }),
    };
  } catch {
    return null;
  }
}
