// The rules a canton-exact transfer must satisfy, read off the decoded
// transaction and nothing else.
//
// Each answers the same shape of question — given this transfer, is there a
// reason to refuse it — and each returns a detail code or null. None of them
// builds a response, reads the requirements' envelope, or knows the order the
// checks run in; that is `canton-exact.ts`. The separation is not aspirational:
// nothing in this file references `fail`, `isObj`, the crypto primitives or the
// wire response types.
//
// The constants are Splice and Token Standard facts, kept beside the rule that
// reads them rather than hoisted, because each one's comment explains why that
// rule treats it the way it does.
//
// SPDX-License-Identifier: Apache-2.0

import { AMULET_INSTRUMENT_ID } from "../networks";
import type { CantonPaymentRequirements } from "../types/requirements";
import { ledgerToAtomic, WIRE_DECIMALS } from "./common";
import type { DecodedTransfer } from "./prepared-tx";
import { recordField, sameTemplate } from "./record-fields";

/**
 * The Token Standard interface a transfer factory exposes, by module and
 * entity.
 *
 * The INTERFACE, not the template. `TransferFactory_Transfer` is defined on
 * this interface, and each registry implements it with its own template —
 * Canton Coin with `ExternalPartyAmuletRules`, another issuer with its own. A
 * check written against Canton Coin's template would refuse every other
 * registry's instrument, though this package routes payments to them by
 * design. The interface is what every transfer factory has in common.
 *
 * The package id is deliberately NOT pinned: it moves with every Splice
 * release, and pinning it would refuse honest payments the day the network
 * upgrades. The name alone proves nothing — anyone can compile a module called
 * this — so what the match is worth is set out below.
 */
const TRANSFER_FACTORY_INTERFACE = {
  moduleName: "Splice.Api.Token.TransferInstructionV1",
  entityName: "TransferFactory",
} as const;

/**
 * What a one-step delivery looks like, per registry.
 *
 * Canton Coin spends a `TransferPreapproval`; `_Send` is the legacy name of the
 * choice and `_SendV2` the one the factory path uses now. A CIP-56 token
 * delivers through its registry utility's transfer rule instead.
 */
const PREAPPROVAL_TEMPLATE = { moduleName: "Splice.AmuletRules", entityName: "TransferPreapproval" };
const PREAPPROVAL_SEND_V2 = "TransferPreapproval_SendV2";
const PREAPPROVAL_SEND_CHOICES = new Set(["TransferPreapproval_Send", PREAPPROVAL_SEND_V2]);
const REGISTRY_DIRECT = {
  choiceId: "TransferRule_DirectTransfer",
  moduleName: "Utility.Registry.V0.Rule.Transfer",
  entityName: "TransferRule",
};

/**
 * The holding a transfer may spend, per registry.
 *
 * Canton Coin's is an `Amulet`, which Rule 13 names, so a `LockedAmulet` is
 * refused. A registry token's is the holding of the same Utility Registry
 * whose transfer rule the delivery check requires. Its layout is known from
 * one real USDCx transfer.
 */
const AMULET_HOLDING = { moduleName: "Splice.Amulet", entityName: "Amulet" };
const REGISTRY_HOLDING = {
  moduleName: "Utility.Registry.Holding.V0.Holding",
  entityName: "Holding",
};

/**
 * The `extensions.detail` codes each refusal produces.
 *
 * Declared as literal unions rather than `string` for the reason
 * `VIOLATION_REASON` is already pinned with `satisfies`: every one of these is
 * asserted by name in the suite and matched by name by a client, so a typo in
 * a new return site would otherwise compile and invent a code nobody handles.
 */
type CreateDetail = "create_unissued";
type FactoryDetail =
  | "factory_unresolved"
  | "factory_interface"
  | "factory_not_preapproval"
  | "factory_signatories"
  | "factory_receiver"
  | "factory_admin"
  | "factory_registry_unconfigured";
type InputsDetail =
  | "inputs_none"
  | "inputs_repeated"
  | "inputs_unresolved"
  | "inputs_template"
  | "inputs_signatories"
  | "inputs_owner"
  | "inputs_admin"
  | "inputs_instrument"
  | "inputs_amount"
  | "inputs_short";
type DeliveryDetail =
  | "no_direct_delivery"
  | "delivery_admin"
  | "delivery_ambiguous"
  | "delivery_amount"
  | "delivery_instrument"
  | "delivery_legacy_send"
  | "delivery_receiver"
  | "delivery_registry_unconfigured"
  | "delivery_registry_untrusted"
  | "delivery_sender"
  | "delivery_signatories"
  | "delivery_unchecked"
  | "delivery_unresolved";

/**
 * Which registry infrastructure parties the caller trusts for this
 * instrument's registrar (spec Rule 7), as the verifier resolved them from
 * `CantonVerifyContext.registryParties`.
 *
 * - `"unchecked"`: the caller passed no `registryParties` (absent or
 *   `undefined`), so the check does not run. This is how every caller
 *   verified before it existed.
 * - `"unconfigured"`: it passed `registryParties`, but with no readable list
 *   for this registrar — `{}`, another registrar's entry, or a value that is
 *   not a map of lists.
 * - a list: the parties trusted beside the registrar itself. Empty is a real
 *   answer, not a missing one: it trusts the registrar alone.
 */
export type RegistryTrust = "unchecked" | "unconfigured" | readonly string[];

/**
 * Two on-ledger `Decimal` amounts, compared as NUMBERS.
 *
 * "0.02" and "0.0200000000" are one amount on a ledger, so comparing the
 * strings would refuse an honest transfer over spelling alone. One scale for
 * every instrument, as elsewhere in this file.
 *
 * An absent left-hand side is not equal to anything: a field the reader could
 * not find is not a match, it is a missing field.
 */
function sameLedgerAmount(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const left = ledgerToAtomic(a, WIRE_DECIMALS);
  const right = ledgerToAtomic(b, WIRE_DECIMALS);
  return left !== null && right !== null && left === right;
}

/**
 * Why a CREATE in this transaction is not one an honest transfer makes, or null.
 *
 * A contract the SENDER signs carries the sender's authority into whatever
 * choices it offers. A look-alike root that delivers the quoted amount honestly
 * can still leave such a contract behind, and whoever controls its choices
 * exercises them later with the payer's authority — long after this payment
 * looked fine. The reference implementation reports measuring exactly that: a
 * create signed by the sender alone, bolted onto the captured Canton Coin and
 * USDCx payments, passed every other check it had.
 *
 * ONLY SENDER-SIGNED CREATES ARE CONSTRAINED, and only to co-signature by the
 * instrument's admin — authority a look-alike root cannot obtain. A create the
 * sender does not sign grants nothing of the payer's and is left alone, which
 * is what keeps the rule off honest traffic: the merchant's own `Amulet` and
 * the featured-app marker are both created without the sender.
 *
 * Every create in every real capture satisfies it — 13 of them across Canton
 * Coin, cBTC and USDCx, where the sender-signed ones are `Amulet [DSO, owner]`,
 * registry `Holding [registrar, owner]` and `TransferOffer [sender,
 * registrar]`. None would be refused.
 */
export function senderSignedCreateViolation(transfer: DecodedTransfer): CreateDetail | null {
  for (const made of transfer.creates ?? []) {
    if (!made.signatories.includes(transfer.sender)) continue;
    if (!made.signatories.includes(transfer.instrumentId.admin)) return "create_unissued";
  }
  return null;
}

/**
 * Why this transfer does not deliver one-step, or null when it does.
 *
 * The same signed `TransferFactory_Transfer` either pays the receiver now or
 * creates a pending instruction the payer can withdraw, decided by whether the
 * receiver held a live preapproval when the factory was built. Nothing in the
 * choice's arguments says which; only the consequences do. Relaying a pending
 * one commits the payer's funds and leaves the merchant unpaid.
 *
 * Read from the SIGNED bytes rather than probed against the ledger: these are
 * the exact bytes to be relayed, so there is no resolve-then-settle window, and
 * a retried settle whose holdings an earlier one consumed still answers the
 * same.
 *
 * WHICH ARM IS CHOSEN BY THE INSTRUMENT. Reading it off the tree would let a
 * payer select the weaker rule by writing the node that selects it.
 *
 * THE TWO ARMS DIFFER IN WHAT THEY READ, not in how much they trust.
 * Canton Coin's preapproval is an input contract of this transaction, so the
 * delivery is bound through the DISCLOSED CONTRACT: whose preapproval it is,
 * and who signed it. A registry token's direct-transfer node carries the
 * transfer record in its own choice ARGUMENT, so what it moves is bound from
 * that. Both arms now also require the exercised contract to resolve, because
 * an argument alone says only what the payer typed.
 *
 * WHAT EACH ARM MOVES is bound too, not just who it pays. The Canton Coin
 * send's own `amount` is read at its declared position and held to the root's;
 * the registry node's `transfer` record is held to the root's sender,
 * receiver, amount and instrument. Binding the preapproval alone says who gets
 * paid, not how much, and a dust send against a correctly bound merchant
 * preapproval passes every other check here.
 *
 * NOT CHECKED: a consequence of NEITHER arm. An unrecognised choice on an
 * unrecognised template is matched by no filter, so neither arm looks at it.
 * Closing that needs a whole-tree allowlist, which would be fail-closed and
 * version-coupled — the day Splice adds a consequence to the transfer body,
 * every caller refuses honest payments. It is left to the ledger, which was
 * measured refusing exactly this shape: an extra consequence node cloned onto
 * a real prepared transaction and re-signed by the payer was rejected on
 * submission (Splice 0.6.0 / Canton 3.4 LocalNet).
 *
 * WHO A REGISTRY DELIVERY RELIES ON is checked too, when the caller says who it
 * trusts — see {@link registryTrustViolation}. Canton Coin's arm has no
 * registry infrastructure parties and ignores `registryTrust`.
 */
export function deliveryViolation(
  transfer: DecodedTransfer,
  requirements: CantonPaymentRequirements,
  registryTrust: RegistryTrust,
): DeliveryDetail | null {
  const consequences = transfer.consequences ?? [];

  const direct = consequences.filter(
    (c) => c.choiceId === REGISTRY_DIRECT.choiceId && sameTemplate(c.templateId, REGISTRY_DIRECT),
  );
  const sends = consequences.filter(
    (c) => PREAPPROVAL_SEND_CHOICES.has(c.choiceId) && sameTemplate(c.templateId, PREAPPROVAL_TEMPLATE),
  );

  // WHICH ARM IS DECIDED BY THE INSTRUMENT, never by a node. Choosing it from
  // what the tree contains would let a payer pick the weaker rule by writing
  // the node that selects it, which is the whole rule defeated by one string.
  //
  // BUT THE ARM NOT CHOSEN STILL HAS TO BE EMPTY. Each arm used to find its
  // own one node, bind it, and return — never looking at the other filter. So
  // a second delivery of the OTHER shape rode along beside a correctly bound
  // one, moving whatever it liked to whoever it liked, read by nothing. Each
  // arm now refuses a tree carrying the other's node as well as its own.
  if (transfer.instrumentId.id !== AMULET_INSTRUMENT_ID) {
    if (direct.length === 0) return "no_direct_delivery";
    // One transfer pays once.
    if (direct.length !== 1) return "delivery_ambiguous";
    // ANCHORED TO A DISCLOSED CONTRACT, as the preapproval arm already is.
    //
    // Without this the arm believed a node's own account of itself. A bare
    // node named TransferRule_DirectTransfer, exercising nothing, carrying a
    // copy of the root's own transfer record, turned a tree this rule exists
    // to refuse — a pending two-step instruction — into a valid payment. The
    // node cost a payer nothing to type, because nothing read where it came
    // from.
    const target = direct[0].target;
    if (!target) return "delivery_unresolved";
    // ... and ISSUED BY THE REGISTRY whose instrument this is, so the rule
    // being exercised belongs to the issuer the quote names rather than to
    // whoever wrote the disclosure.
    //
    // Narrower than the factory-signatory rule this package removed, and for
    // the reason that one was wrong: a FACTORY may legitimately be a
    // merchant's own preapproval, which its admin does not sign. This arm
    // fires only for the pinned Utility.Registry rule template, a contract the
    // registry owns. Every consequence target of every real capture carries
    // its instrument's admin as a signatory — 11 of 11 across Canton Coin,
    // cBTC and USDCx — but only one of those is a registry delivery, so if an
    // honest registry payment is ever refused here, this is the line to look
    // at first.
    if (!target.signatories.includes(transfer.instrumentId.admin)) return "delivery_admin";
    // ... and relying on no registry infrastructure party the caller has not
    // configured for that issuer (Rule 7). The admin above proves whose rule
    // it is; it says nothing about who else signed it or is named in it.
    const untrusted = registryTrustViolation(transfer, target, registryTrust);
    if (untrusted) return untrusted;
    // What the delivery MOVES, from the whole Transfer record it takes as its
    // argument — and must be what the root said it would move. The
    // reference facilitator reports catching real bytes this way: a root over
    // an inflated direct transfer, where the signed root looked right and the
    // leg that actually paid did not.
    const delivers = direct[0].delivers;
    if (!delivers) return "delivery_unresolved";
    if (delivers.sender !== transfer.sender) return "delivery_sender";
    if (delivers.receiver !== transfer.receiver) return "delivery_receiver";
    if (
      delivers.instrumentId.id !== transfer.instrumentId.id ||
      delivers.instrumentId.admin !== transfer.instrumentId.admin
    ) {
      return "delivery_instrument";
    }
    if (!sameLedgerAmount(delivers.amount, transfer.amount)) return "delivery_amount";
    if (sends.length > 0) return "delivery_unchecked";
    return null;
  }

  if (sends.length === 0) return "no_direct_delivery";
  // Two sends would be two deliveries, and binding either one would leave the
  // other unchecked.
  if (sends.length !== 1) return "delivery_ambiguous";

  // THE LIVE FACTORY EXERCISES SendV2. The legacy `_Send` stays in the locator
  // set above so the node is FOUND and answered precisely, rather than reported
  // as no delivery at all — but its argument layout is unmeasured (no Splice
  // AmuletRules package on disk to read it from), so binding its amount would
  // mean reading a position nobody checked. Refused rather than guessed, which
  // is what the reference implementation does with it.
  if (sends[0].choiceId !== PREAPPROVAL_SEND_V2) return "delivery_legacy_send";

  // WHAT THE SEND ITSELF MOVES. Binding the preapproval alone says who gets
  // paid, not how much: a dust send against a correctly bound merchant
  // preapproval delivers a fraction of the quoted amount, and every other check
  // here passes. The reference implementation binds this, having measured real
  // bytes where the signed root and the leg that paid disagreed.
  //
  // `amount` is declaration index 2 of `{context, inputs, amount, sender}`,
  // confirmed on all three real Canton Coin captures, where it equals the
  // root's exactly.
  const sent = recordField(sends[0].chosenArgument ?? [], "amount", 2);
  if (!sameLedgerAmount(sent, transfer.amount)) return "delivery_amount";

  const target = sends[0].target;
  // The preapproval must be disclosed by this transaction, so there is a
  // contract to read rather than a bare id.
  if (!target) return "delivery_unresolved";

  const dso = recordField(target.argument, "dso", 0);
  const receiver = recordField(target.argument, "receiver", 1);
  const provider = recordField(target.argument, "provider", 2);
  if (!dso || !receiver || !provider) return "delivery_unresolved";
  // A preapproval belonging to anyone else grants nothing.
  if (receiver !== requirements.payTo) return "delivery_receiver";
  if (dso !== transfer.instrumentId.admin) return "delivery_admin";
  // The signatories must be exactly the parties the record names — no more, no
  // fewer. Compared as SETS rather than against a literal three, because a
  // merchant that runs its own validator is its own provider, and that stock
  // two-signatory preapproval delivers perfectly well. Only the fully
  // degenerate case, where one party fills all three roles, is refused: there
  // is then no issuer distinct from the receiver.
  const want = new Set([dso, receiver, provider]);
  const signatories = new Set(target.signatories);
  if (signatories.size !== want.size) return "delivery_signatories";
  if (![...want].every((p) => signatories.has(p))) return "delivery_signatories";
  if (provider === receiver && provider === dso) return "delivery_signatories";
  if (direct.length > 0) return "delivery_unchecked";
  return null;
}

/**
 * The registry infrastructure parties a Utility Registry contract names, at
 * their declaration index. The `TransferRule` and the `Holding` both open with
 * `{operator, provider, registrar, ...}`, so one table reads both.
 *
 * The layout is known from two registries only — the MainNet USDCx transfer
 * and FTP's cBTC offers — which agree: the Utility's operator first, the
 * token's provider second. cBTC's holdings name the registrar itself as
 * provider, which the set comparison below admits without a special case.
 *
 * The rule's own `registrar` (field 2) is not read here: Rule 7 asks that the
 * rule be the registrar's, which `delivery_admin` already holds through its
 * signatories, and a holding's registrar is bound by `inputsViolation`.
 */
const INFRASTRUCTURE_FIELDS = [
  ["operator", 0],
  ["provider", 1],
] as const;

/**
 * Why a registry delivery relies on a party the caller does not trust for this
 * registrar, or null (spec Rule 7: "The registry infrastructure parties that
 * appear in a registry transfer ... are trusted only when the facilitator is
 * configured with them for that registrar").
 *
 * Three places name such a party: the `TransferRule`'s signatories, the rule's
 * own `operator` and `provider`, and each input holding's `operator` and
 * `provider`. The rule's fields are read as well as its signatories because
 * a real rule is signed only by its provider and the registrar, so the
 * signatories alone never show the operator.
 *
 * COMPARED AS A SET, NOT BY ROLE. Each party has only to be the registrar or
 * one the caller listed for it; the configuration does not say which party
 * fills which field. Two captured registries agree on the layout, which is not
 * enough to pin roles on every registry.
 *
 * A field the reader cannot find is refused rather than skipped: absent, at
 * another type, or — in a record bound by declaration order — carrying a
 * label that contradicts the one declared at its index. A party the reader
 * cannot find is not one it trusts.
 *
 * The holdings are read HERE, not in `inputsViolation`, because that
 * function's refusals answer `insufficient_inputs`, and an untrusted party is
 * Rule 7's. This runs before `inputsViolation`, so an input that does not
 * resolve, or is not a registry holding, is skipped and left to it: it answers
 * those more precisely (`inputs_unresolved`, `inputs_template`).
 */
function registryTrustViolation(
  transfer: DecodedTransfer,
  rule: { signatories: readonly string[]; argument: readonly { label: string; value?: string }[] },
  registryTrust: RegistryTrust,
): DeliveryDetail | null {
  // The caller never said whom it trusts, so the check does not run — the
  // behaviour every caller had before it existed.
  if (registryTrust === "unchecked") return null;
  // It said whom it trusts, and named nobody for this registrar: nobody
  // configured this token, so it does not settle.
  if (registryTrust === "unconfigured") return "delivery_registry_unconfigured";

  const trusted = new Set([transfer.instrumentId.admin, ...registryTrust]);
  const isTrusted = (party: string | undefined): boolean =>
    party !== undefined && trusted.has(party);

  if (!rule.signatories.every(isTrusted)) return "delivery_registry_untrusted";
  for (const [label, index] of INFRASTRUCTURE_FIELDS) {
    if (!isTrusted(recordField(rule.argument, label, index))) return "delivery_registry_untrusted";
  }
  for (const input of transfer.inputs ?? []) {
    const holding = input.contract;
    if (!holding || !sameTemplate(holding.templateId, REGISTRY_HOLDING)) continue;
    for (const [label, index] of INFRASTRUCTURE_FIELDS) {
      if (!isTrusted(partyAt(holding.argument, label, index))) return "delivery_registry_untrusted";
    }
  }
  return null;
}

/**
 * The real-factory proof, as far as this layer can take it.
 *
 * The exercise must go through the Token Standard transfer-factory interface,
 * against a contract the transaction itself discloses — exactly one, agreeing
 * with the exercise about what it is.
 *
 * WHAT THIS DOES NOT DO — two gaps, both real.
 *
 * The disclosure is PAYER-WRITTEN. `input_contracts` is part of the blob the
 * payer signs, so every field read here is a field the payer chose. What makes
 * the check bite is not this layer: it is the synchronizer, which
 * authenticates a disclosed contract against its contract id at submission, so
 * a fabricated disclosure never settles. The proof is therefore self-attested
 * here and enforced at settlement — a caller that verifies without settling
 * gets no protection from it.
 *
 * The issuer binding is not here either — for Canton Coin, or for a registry
 * token whose caller passes no `registryParties`. It runs through `expectedAdmin`,
 * which the transfer names and which the standard requires the factory to
 * validate against its own admin — see `readTransfer`. That admin is
 * MERCHANT-QUOTED, so closing the last gap needs the real DSO party, which
 * this layer has no way to know; the facilitator holds it as
 * `provider.dsoPartyId` and is where that comparison belongs.
 *
 * What the rule does buy: a payer cannot swap in a contract of their own that
 * merely exposes a same-named choice and have it SETTLE, which before this
 * check it could.
 *
 * A REGISTRY TOKEN'S FACTORY is also held to the one spec Rule 3 names, when
 * the caller says which registrars it trusts — see
 * {@link registryFactoryViolation}. Canton Coin's arm is unchanged.
 */
export function factoryViolation(
  transfer: DecodedTransfer,
  requirements: CantonPaymentRequirements,
  registryTrust: RegistryTrust,
): FactoryDetail | null {
  const exercised = transfer.exercisedContract;
  // Absent means the decoder could not resolve the exercised contract to
  // exactly one input contract that agrees with it — see resolveExercised.
  if (!exercised) return "factory_unresolved";
  // A choice exercised on the template directly carries no interface, so an
  // absent one is refused rather than read as "no interface required".
  const inherited = exercised.interfaceId;
  if (!inherited) return "factory_interface";
  if (!sameTemplate(inherited, TRANSFER_FACTORY_INTERFACE)) return "factory_interface";
  // WHO SIGNED THE FACTORY is not a Token Standard question — `TransferFactory`
  // is an interface and signatories are an implementation's own choice — and
  // real bytes bear that out: Canton Coin's factory is signed by the DSO, but
  // a Utility Registry transfer exercises the MERCHANT's own preapproval,
  // signed by the merchant and not the issuer at all. A rule inferred from
  // Canton Coin refused those outright. So it is checked per arm, from what
  // spec Rule 3 names for that arm, never from one shape for both.
  //
  // Canton Coin's arm is still not checked here. What binds its factory to the
  // issuer is `expectedAdmin`, held to the instrument's admin where the
  // transfer is read, and which the standard requires the factory to validate
  // against its own admin — the ledger's to enforce, and the facilitator holds
  // the admin to its own DSO party.
  if (transfer.instrumentId.id !== AMULET_INSTRUMENT_ID) {
    return registryFactoryViolation(transfer, exercised, requirements, registryTrust);
  }
  return null;
}

/**
 * The receiver's own registry preapproval, which spec Rule 3 requires a
 * registry token's transfer to exercise. Matched on module and entity, like
 * every template here: the package id moves with each release.
 */
const REGISTRY_PREAPPROVAL = {
  moduleName: "Utility.Registry.App.V0.Model.TransferPreapproval",
  entityName: "TransferPreapproval",
};

/**
 * Why a registry token's factory is not the one spec Rule 3 names, or null:
 * "the receiver's own registry `TransferPreapproval` whose only signatory is
 * `payTo`, naming `payTo` as receiver and `extra.instrumentId.admin` as
 * instrument admin, for a registrar the facilitator is configured to settle."
 *
 * OPT-IN, on the same switch as Rule 7's trust check: it runs only when the
 * caller passes `registryParties`, which is also what says which registrars
 * it settles. Without it nothing here runs — not even the answer for a payee
 * with no preapproval changes — so every caller written before it verifies
 * exactly as before.
 *
 * A PAYEE WITH NO PREAPPROVAL is answered here, before delivery: its transfer
 * exercises the registry's own factory, which leaves a two-step offer.
 * `factory_not_preapproval` names that case on its own, because a malformed
 * payload alone would not tell a merchant to create one.
 *
 * Its record is `{operator, receiver, instrumentAdmin, instrumentAllowances}`,
 * read through `recordField` by label or declared position, as the captured
 * MainNet USDCx preapproval lays it out. A field the reader cannot find
 * refuses, as a field that names someone else does.
 */
function registryFactoryViolation(
  transfer: DecodedTransfer,
  factory: NonNullable<DecodedTransfer["exercisedContract"]>,
  requirements: CantonPaymentRequirements,
  registryTrust: RegistryTrust,
): FactoryDetail | null {
  if (registryTrust === "unchecked") return null;
  // Nobody configured this registrar, so whatever its factory is, nothing
  // here settles its tokens.
  if (registryTrust === "unconfigured") return "factory_registry_unconfigured";
  if (!sameTemplate(factory.templateId, REGISTRY_PREAPPROVAL)) return "factory_not_preapproval";
  // The receiver's OWN: signed by `payTo` and nobody else. Compared as a set,
  // so a repeated signatory is still one party.
  const signatories = new Set(factory.signatories);
  if (signatories.size !== 1 || !signatories.has(requirements.payTo)) {
    return "factory_signatories";
  }
  const argument = factory.argument ?? [];
  if (recordField(argument, "receiver", 1) !== requirements.payTo) return "factory_receiver";
  if (recordField(argument, "instrumentAdmin", 2) !== transfer.instrumentId.admin) {
    return "factory_admin";
  }
  return null;
}

type HoldingRecord = NonNullable<
  NonNullable<DecodedTransfer["inputs"]>[number]["contract"]
>["argument"];

// A holding's fields, each bound through `recordField` as the engine binds it
// and read at its declared type. A field written at another type reads as
// absent, so a Party spelled as Text is refused rather than compared.
function partyAt(
  record: HoldingRecord | undefined,
  label: string,
  index: number,
): string | undefined {
  const value = record && recordField(record, label, index);
  return value && "party" in value ? value.party : undefined;
}

function textAt(
  record: HoldingRecord | undefined,
  label: string,
  index: number,
): string | undefined {
  const value = record && recordField(record, label, index);
  return value && "text" in value ? value.text : undefined;
}

function numericAt(
  record: HoldingRecord | undefined,
  label: string,
  index: number,
): string | undefined {
  const value = record && recordField(record, label, index);
  return value && "numeric" in value ? value.numeric : undefined;
}

function recordAt(
  record: HoldingRecord | undefined,
  label: string,
  index: number,
): HoldingRecord | undefined {
  const value = record && recordField(record, label, index);
  return value && "record" in value ? value.record : undefined;
}

/**
 * Why the transfer's inputs cannot pay for it, or null (spec Rule 13).
 *
 * Every declared input must be exactly one input contract of this transaction:
 * a holding of the quoted instrument, owned by the sender and signed by exactly
 * the instrument's admin and the sender. Together they must cover the amount.
 * Without this a transfer that spends nothing, or someone else's holdings,
 * verified as valid and failed only when the ledger ran it.
 *
 * The arm is chosen by the instrument, as delivery's is. A Canton Coin
 * holding's amount is its `initialAmount`, since a transfer charges no holding
 * fee on its inputs (CIP-0078), so the rest of `amount` is not read.
 *
 * Not checked: whether an input is still unspent, and whether its disclosure
 * is genuine. The disclosure is the payer's, as the factory's is, and the
 * ledger authenticates each input against its id and refuses a spent one when
 * the transfer executes.
 */
export function inputsViolation(transfer: DecodedTransfer): InputsDetail | null {
  const inputs = transfer.inputs ?? [];
  if (inputs.length === 0) return "inputs_none";
  // A holding counted twice would pay for itself twice.
  if (new Set(inputs.map((input) => input.contractId)).size !== inputs.length)
    return "inputs_repeated";

  const { admin, id } = transfer.instrumentId;
  const sender = transfer.sender;
  const amulet = id === AMULET_INSTRUMENT_ID;
  const want = new Set([admin, sender]);
  let total = 0n;
  // Every input is checked and none is skipped: one that fails refuses the
  // payment, even when the others would cover it.
  for (const input of inputs) {
    const holding = input.contract;
    if (!holding) return "inputs_unresolved";
    if (!sameTemplate(holding.templateId, amulet ? AMULET_HOLDING : REGISTRY_HOLDING))
      return "inputs_template";
    // Exactly these two, compared as sets, as the preapproval's signatories are.
    const signatories = new Set(holding.signatories);
    if (signatories.size !== want.size) return "inputs_signatories";
    if (![...want].every((p) => signatories.has(p))) return "inputs_signatories";

    const record = holding.argument;
    // Amulet is {dso, owner, amount: {initialAmount, ...}}. The registry's
    // Holding is {operator, provider, registrar, owner, instrument: {source,
    // id, scheme}, label, amount}.
    if (partyAt(record, "owner", amulet ? 1 : 3) !== sender) return "inputs_owner";
    if (partyAt(record, amulet ? "dso" : "registrar", amulet ? 0 : 2) !== admin)
      return "inputs_admin";
    if (!amulet && textAt(recordAt(record, "instrument", 4), "id", 1) !== id)
      return "inputs_instrument";
    const amount = amulet
      ? numericAt(recordAt(record, "amount", 2), "initialAmount", 0)
      : numericAt(record, "amount", 6);
    const atomic = amount === undefined ? null : ledgerToAtomic(amount, WIRE_DECIMALS);
    if (atomic === null) return "inputs_amount";
    total += atomic;
  }
  const needed = ledgerToAtomic(transfer.amount, WIRE_DECIMALS);
  if (needed === null || total < needed) return "inputs_short";
  return null;
}
