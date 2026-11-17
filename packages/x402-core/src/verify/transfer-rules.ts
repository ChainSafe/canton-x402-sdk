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
 * The `extensions.detail` codes each refusal produces.
 *
 * Declared as literal unions rather than `string` for the reason
 * `VIOLATION_REASON` is already pinned with `satisfies`: every one of these is
 * asserted by name in the suite and matched by name by a client, so a typo in
 * a new return site would otherwise compile and invent a code nobody handles.
 */
type CreateDetail = "create_unissued";
type FactoryDetail = "factory_unresolved" | "factory_interface";
type DeliveryDetail =
  | "no_direct_delivery"
  | "delivery_admin"
  | "delivery_ambiguous"
  | "delivery_amount"
  | "delivery_instrument"
  | "delivery_legacy_send"
  | "delivery_receiver"
  | "delivery_sender"
  | "delivery_signatories"
  | "delivery_unchecked"
  | "delivery_unresolved";

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
 */
export function deliveryViolation(
  transfer: DecodedTransfer,
  requirements: CantonPaymentRequirements,
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
 * The issuer binding is not here either. It runs through `expectedAdmin`,
 * which the transfer names and which the standard requires the factory to
 * validate against its own admin — see `readTransfer`. That admin is
 * MERCHANT-QUOTED, so closing the last gap needs the real DSO party, which
 * this layer has no way to know; the facilitator holds it as
 * `provider.dsoPartyId` and is where that comparison belongs.
 *
 * What the rule does buy: a payer cannot swap in a contract of their own that
 * merely exposes a same-named choice and have it SETTLE, which before this
 * check it could.
 */
export function factoryViolation(transfer: DecodedTransfer): FactoryDetail | null {
  const exercised = transfer.exercisedContract;
  // Absent means the decoder could not resolve the exercised contract to
  // exactly one input contract that agrees with it — see resolveExercised.
  if (!exercised) return "factory_unresolved";
  // A choice exercised on the template directly carries no interface, so an
  // absent one is refused rather than read as "no interface required".
  const inherited = exercised.interfaceId;
  if (!inherited) return "factory_interface";
  if (!sameTemplate(inherited, TRANSFER_FACTORY_INTERFACE)) return "factory_interface";
  // NOT CHECKED: who signed the factory. The Token Standard says nothing about
  // it — `TransferFactory` is an interface and signatories are an
  // implementation's own choice — and real bytes bear that out: Canton Coin's
  // factory is signed by the DSO, but a Utility Registry transfer exercises
  // the MERCHANT's own preapproval, signed by the merchant and not the issuer
  // at all. A rule inferred from Canton Coin refused those outright.
  //
  // What binds the factory to the issuer is `expectedAdmin`, held to the
  // instrument's admin where the transfer is read, and which the standard
  // requires the factory to validate against its own admin. That link is the
  // ledger's to enforce and holds only because vetted packages implement the
  // MUST — it cannot be checked from the bytes, so nothing here tries.
  return null;
}
