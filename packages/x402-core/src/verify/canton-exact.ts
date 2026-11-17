// The canton-exact scheme verifier + its Canton-specific primitives — that is,
// scheme `exact` on a `canton:*` network. Composes the scheme-agnostic checks in
// ./common with Ed25519 signature verification, the Canton key-fingerprint
// derivation, and the canton-id / canton-payload shape guards. Pure and
// stateless — the stateful guards (replay) and on-chain execution stay in
// the facilitator, which composes this verifier's result.

import {
  sign as ed25519Sign,
  verify as ed25519Verify,
  hashes as ed25519Hashes,
} from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { AMULET_INSTRUMENT_ID } from "../networks";
import type { NetworkId } from "../types/common";
import { HashingSchemeVersion, isCantonPaymentInner } from "../types/payment";
import { CantonPaymentRequirements, isCantonPaymentRequirements } from "../types/requirements";
import type {
  SchemeVerifier,
  VerifyInvalidReason,
  CantonExactExtensionReason,
  SpecVerifyInvalidReason,
  VerifyResponse,
  VerifyResponseInvalid,
} from "../types/facilitator";
import type { X402PaymentPayload } from "../types/payment";
import type { X402PaymentRequirements } from "../types/requirements";
import {
  isValidAmount,
  ledgerToAtomic,
  WIRE_DECIMALS,
} from "./common";
import { decodePreparedTransaction, type DecodedTransfer } from "./prepared-tx";
import { gunzipPreparedTransaction } from "./prepared-tx-codec";
import { computePreparedTransactionHash } from "./prepared-tx-hash";
import { guardPreparedTransaction } from "./prepared-tx-guard";

// @noble/ed25519 v3 needs sha512 wired (same as the facilitator's wallet.ts).
ed25519Hashes.sha512 = sha512;

/**
 * The scheme identifier on the wire, defined by the registered Canton scheme spec
 * (`specs/schemes/exact/scheme_exact_canton.md`). Exported so the facilitator
 * reads it from here rather than repeating the literal.
 */
export const EXACT_SCHEME_ID = "exact";

/** Canton hash-purpose tag for key fingerprints. */
const HASH_PURPOSE_FINGERPRINT = Uint8Array.of(0x00, 0x00, 0x00, 0x0c);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** base64 → bytes. Isomorphic: `atob` is global in Node 18+ and browsers. */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Canton key fingerprint for a base64 Ed25519 public key:
 * `1220` + hex(SHA-256(0x0000000c ‖ pubkey)). Must equal the payer party's
 * `::<fingerprint>` suffix. Ported from the facilitator (parity-tested).
 */
export function fingerprintForPublicKey(publicKeyBase64: string): string {
  const pk = base64ToBytes(publicKeyBase64);
  if (pk.length !== 32) throw new Error("ed25519 public key must be 32 bytes");
  return "1220" + bytesToHex(sha256(concatBytes(HASH_PURPOSE_FINGERPRINT, pk)));
}

/** True iff the public key's fingerprint equals the claimed one (case-insensitive). */
export function matchesFingerprint(publicKeyBase64: string, claimedFingerprint: string): boolean {
  return fingerprintForPublicKey(publicKeyBase64).toLowerCase() === claimedFingerprint.toLowerCase();
}

/**
 * Verify an Ed25519 signature (hex) over a prepared-transaction hash (hex) with a
 * base64 public key. Length-checks defensively; returns false on any error.
 */
export function verifySignature(
  hashHex: string,
  signatureHex: string,
  publicKeyBase64: string,
): boolean {
  try {
    const pk = base64ToBytes(publicKeyBase64);
    const sig = hexToBytes(signatureHex);
    const msg = hexToBytes(hashHex);
    if (pk.length !== 32 || sig.length !== 64) return false;
    return ed25519Verify(sig, msg, pk);
  } catch {
    return false;
  }
}

/**
 * Ed25519-sign a prepared-transaction hash (hex) with a base64 32-byte seed,
 * returning the signature as hex. Counterpart to {@link verifySignature} — the
 * signature it produces is exactly what `verifySignature` (and the facilitator)
 * accept.
 */
export function signHash(hashHex: string, privateKeyBase64: string): string {
  const seed = base64ToBytes(privateKeyBase64);
  if (seed.length !== 32) throw new Error("ed25519 private key must be a 32-byte seed");
  return bytesToHex(ed25519Sign(hexToBytes(hashHex), seed));
}

/**
 * How much future an `executeBefore` must have left to be worth accepting.
 * Settling is not instantaneous, so a transfer expiring inside this window is
 * one the ledger refuses after the work of relaying it has been done.
 */
const EXECUTE_BEFORE_MARGIN_MICROS = 5_000_000n;

/** Rule 10: the deadline must be ahead of now by the margin. Absent counts as expired. */
function isTransferExpired(executeBeforeMicros: bigint | undefined, now: number = Date.now()): boolean {
  if (executeBeforeMicros === undefined) return true;
  return executeBeforeMicros <= BigInt(now) * 1000n + EXECUTE_BEFORE_MARGIN_MICROS;
}

// ─── payload encodings ──────────────────────────────────────────────────────
// The payload carries `preparedTxHash` as lower-case hex and `signature` as
// base64, which are the spec's encodings. signHash / verifySignature stay in hex
// because the facilitator's login flow calls them with hex too. The two
// helpers below convert at the payload boundary, so the hex side never changes.

/** 32 bytes as lower-case hex: the only form `preparedTxHash` takes. */
const PREPARED_TX_HASH = /^[0-9a-f]{64}$/;

/** Standard alphabet, padded, nothing else. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** 64 bytes always encode to 88 characters of padded base64. */
const SIGNATURE_BASE64_LENGTH = 88;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * A hex Ed25519 signature (what {@link signHash} returns) in the base64 form the
 * payload's `signature` carries.
 */
export function signatureToBase64(signatureHex: string): string {
  return bytesToBase64(hexToBytes(signatureHex));
}

/**
 * The payload's `signature` back to hex, for {@link verifySignature}. `null`
 * unless it is canonical standard base64 of exactly 64 bytes. A hex signature
 * is valid base64 (its 128 characters decode to 96 bytes), so the length check
 * is what keeps it from being read as one. Canonical means the encoding
 * {@link signatureToBase64} produces: no URL-safe alphabet, no missing padding,
 * no non-zero padding bits.
 *
 * The length is checked first because the value comes from the client. Run on
 * a few million characters, the regex below exhausts V8's backtracking stack
 * and throws instead of returning false.
 */
export function signatureFromBase64(signatureBase64: string): string | null {
  if (signatureBase64.length !== SIGNATURE_BASE64_LENGTH || !BASE64.test(signatureBase64)) {
    return null;
  }
  const bytes = base64ToBytes(signatureBase64);
  if (bytes.length !== 64 || bytesToBase64(bytes) !== signatureBase64) return null;
  return bytesToHex(bytes);
}

// ─── canton network-id boundary guard ──────────────────────────────────────
// NetworkId is a plain string (scheme-generic); this validates the `canton:<name>`
// form at untrusted boundaries (env, raw input). Shape only — that the name is
// one this deployment settles is the verifier's network check, not this guard's.

export function isCantonNetworkId(x: unknown): x is NetworkId {
  return typeof x === "string" && /^canton:.+/.test(x);
}

export function parseCantonNetworkId(s: string): NetworkId {
  if (!isCantonNetworkId(s)) throw new Error(`not a canton network id: ${s}`);
  return s;
}

/**
 * A refusal. `invalidReason` is the spec's code, the one a client written
 * against the spec matches on. `extensions.reason` is the code this verifier
 * answered with before, kept beside it until those are dropped, and
 * `extensions.detail` says what diverged where there is more to say.
 */
function fail(
  invalidReason: VerifyInvalidReason,
  reason: VerifyInvalidReason,
  payer?: string,
  detail?: string,
): VerifyResponseInvalid {
  return {
    isValid: false,
    invalidReason,
    ...(payer ? { payer } : {}),
    extensions: { reason, ...(detail !== undefined ? { detail } : {}) },
  };
}

/**
 * What distinguishes the PHYSICAL synchronizer id from the LOGICAL one in
 * `Metadata.synchronizer_id`: `<protocol-version>-<serial>`. Both are the
 * synchronizer's own, not the participant's — the protocol version is fixed
 * when it is initialised, the serial steps on a logical upgrade. Two decimal
 * runs, one hyphen, nothing else.
 */
const PHYSICAL_SYNCHRONIZER_SUFFIX = /^[0-9]+-[0-9]+$/;

/**
 * Is the signed synchronizer id the one the merchant quoted?
 *
 * `prepare` takes the logical id and refuses the physical one, and the bytes
 * it returns carry EITHER form depending on the Canton release — the logical
 * id on what LocalNet runs, the physical one on newer releases. So both are
 * taken: exact equality would refuse every honest payment from the latter.
 *
 * A suffixed match is not a weakening: the `1220…` is the domain's namespace
 * fingerprint, so `<quoted>::<n>-<m>` is provably the same domain at some
 * protocol version and serial. Another name, another fingerprint, a
 * non-numeric or three-part suffix, or any trailing text is refused, and an
 * absent id counts as a mismatch.
 */
function synchronizerMatches(signed: string | undefined, quoted: string): boolean {
  if (signed === undefined) return false;
  if (signed === quoted) return true;
  if (!signed.startsWith(`${quoted}::`)) return false;
  return PHYSICAL_SYNCHRONIZER_SUFFIX.test(signed.slice(quoted.length + 2));
}

/**
 * The code for each field {@link findTransferMismatch} can name.
 *
 * Typed to the spec's table plus this scheme's own extensions, and nothing
 * else: `VerifyInvalidReason` also admits our protocol-level codes, and one of
 * them sat here answering the synchronizer — a slot no spec-written client
 * would have matched. The synchronizer still answers an extension, because the
 * spec defines no code for it; the type now says so rather than filing it
 * under the spec's.
 */
const MISMATCH_REASON = {
  memo: "invalid_exact_canton_memo_mismatch",
  synchronizer: "invalid_exact_canton_synchronizer_mismatch",
  receiver: "invalid_exact_canton_merchant_mismatch",
  instrument: "invalid_exact_canton_instrument_id_mismatch",
  amount: "invalid_exact_canton_amount_mismatch",
} as const satisfies Record<
  NonNullable<ReturnType<typeof findTransferMismatch>>,
  SpecVerifyInvalidReason | CantonExactExtensionReason
>;

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

type Consequence = NonNullable<DecodedTransfer["consequences"]>[number];
type DisclosedArgument = NonNullable<Consequence["target"]>["argument"];

/** A disclosure's field by label, falling back to declaration order, as `pick` does. */
function argField(argument: DisclosedArgument, label: string, index: number): string | undefined {
  // The engine's rule, as `pick` reads it in the decoder: a record binds BY
  // LABEL only when EVERY field carries one. A single blank label puts the
  // whole record in declaration order, and a label still present is then
  // checked against the name declared at its own index.
  //
  // This read `some`, the inverse, which is how a record with one blank label
  // could be read here by name while the ledger read it by position — and this
  // is the reader that decides whose preapproval the delivery spends.
  if (argument.every((f) => f.label !== "")) return argument.find((f) => f.label === label)?.value;
  const field = argument[index];
  if (!field) return undefined;
  if (field.label !== "" && field.label !== label) return undefined;
  return field.value;
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
function createFailure(transfer: DecodedTransfer): string | null {
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
function deliveryFailure(
  transfer: DecodedTransfer,
  requirements: CantonPaymentRequirements,
): string | null {
  const consequences = transfer.consequences ?? [];

  const direct = consequences.filter(
    (c) =>
      c.choiceId === REGISTRY_DIRECT.choiceId &&
      c.templateId.moduleName === REGISTRY_DIRECT.moduleName &&
      c.templateId.entityName === REGISTRY_DIRECT.entityName,
  );
  const sends = consequences.filter(
    (c) =>
      PREAPPROVAL_SEND_CHOICES.has(c.choiceId) &&
      c.templateId.moduleName === PREAPPROVAL_TEMPLATE.moduleName &&
      c.templateId.entityName === PREAPPROVAL_TEMPLATE.entityName,
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
    if (delivers.instrumentId.id !== transfer.instrumentId.id) return "delivery_instrument";
    if (delivers.instrumentId.admin !== transfer.instrumentId.admin) return "delivery_instrument";
    // Both are on-ledger Decimals, where "0.02" and "0.0200000000" are one
    // amount — comparing the strings would refuse an honest transfer over
    // spelling. One scale for every instrument, as elsewhere in this file.
    const delivered = ledgerToAtomic(delivers.amount, WIRE_DECIMALS);
    const rooted = ledgerToAtomic(transfer.amount, WIRE_DECIMALS);
    if (delivered === null || rooted === null || delivered !== rooted) return "delivery_amount";
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
  const sent = argField(sends[0].chosenArgument ?? [], "amount", 2);
  const sentAtomic = sent === undefined ? null : ledgerToAtomic(sent, WIRE_DECIMALS);
  const rootAtomic = ledgerToAtomic(transfer.amount, WIRE_DECIMALS);
  if (sentAtomic === null || rootAtomic === null || sentAtomic !== rootAtomic) {
    return "delivery_amount";
  }

  const target = sends[0].target;
  // The preapproval must be disclosed by this transaction, so there is a
  // contract to read rather than a bare id.
  if (!target) return "delivery_unresolved";

  const dso = argField(target.argument, "dso", 0);
  const receiver = argField(target.argument, "receiver", 1);
  const provider = argField(target.argument, "provider", 2);
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
function factoryProofFailure(transfer: DecodedTransfer): string | null {
  const exercised = transfer.exercisedContract;
  // Absent means the decoder could not resolve the exercised contract to
  // exactly one input contract that agrees with it — see resolveExercised.
  if (!exercised) return "factory_unresolved";
  // A choice exercised on the template directly carries no interface, so an
  // absent one is refused rather than read as "no interface required".
  const inherited = exercised.interfaceId;
  if (!inherited) return "factory_interface";
  if (inherited.moduleName !== TRANSFER_FACTORY_INTERFACE.moduleName) return "factory_interface";
  if (inherited.entityName !== TRANSFER_FACTORY_INTERFACE.entityName) return "factory_interface";
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

/** The fields Rule 2 calls the proof. */
const PROOF_FIELDS = ["preparedTransaction", "preparedTxHash", "signature"] as const;

/**
 * The pure canton-exact verification, factored out of the facilitator's
 * `V2CantonExact.verify`. Runs the stateless checks in order; the facilitator's
 * stateful checks (replay, min-amount FX policy) and the on-chain execute
 * compose on top of a successful result here.
 */
async function verifyCantonExact(
  networkId: NetworkId,
  payload: X402PaymentPayload<unknown, unknown>,
  requirements: X402PaymentRequirements<unknown>,
): Promise<VerifyResponse> {
  // 1. scheme — the requirements the payer chose (`accepted`) and the ones it
  //    is verified against must both name the one id the spec defines (Rule 1).
  //    A payment with no `accepted`, or a pre-spec envelope that carries the
  //    scheme at the top level instead, names none.
  const accepted = isObj(payload.accepted) ? payload.accepted : undefined;
  if (payload.x402Version !== 2) return fail("invalid_x402_version", "internal_error");
  if (!accepted) return fail("unsupported_scheme", "scheme_mismatch");
  if (accepted.scheme !== EXACT_SCHEME_ID || requirements.scheme !== EXACT_SCHEME_ID) {
    return fail("unsupported_scheme", "scheme_mismatch");
  }
  // 2. network — accepted, requirements, and this verifier's binding must agree
  if (accepted.network !== requirements.network || requirements.network !== networkId) {
    return fail("invalid_network", "network_mismatch");
  }
  // 3. shapes — narrow the unknown inner/requirements before reading fields.
  //    `assetTransferMethod` is the same literal in both schemas, so once both
  //    pass, the payload's method and the requirements' agree.
  if (!isCantonPaymentRequirements(requirements)) {
    return fail("invalid_payment_requirements", "internal_error");
  }
  if (!isObj(payload.payload)) return fail("invalid_exact_canton_missing_proof", "internal_error");
  const raw = payload.payload;
  // Rule 2: a proof that is not there is missing_proof, one that is there but
  // not well-formed is malformed_payload. The key is not in the spec's
  // payload, but nothing can be checked without it, so its absence is a
  // missing proof too. The checks keep the order they had, so
  // `extensions.reason` stays what this verifier answered before: the key
  // first, and an empty field left to the checks that refused it.
  if (typeof raw.publicKey !== "string" || !raw.publicKey) {
    return fail("invalid_exact_canton_missing_proof", "missing_public_key");
  }
  if (PROOF_FIELDS.some((field) => typeof raw[field] !== "string")) {
    return fail("invalid_exact_canton_missing_proof", "internal_error");
  }
  if (!isCantonPaymentInner(raw)) return fail("invalid_exact_canton_malformed_payload", "internal_error");
  const inner = raw;
  // 4. Gunzip exactly once: guarding, decoding and hashing all use these
  //    bytes. A member that is malformed or over either bound is as
  //    undecodable as a bad protobuf.
  const prepared = gunzipPreparedTransaction(inner.preparedTransaction);
  if (prepared === null) {
    return fail("invalid_exact_canton_malformed_payload", "transfer_mismatch", undefined, "undecodable");
  }
  const preparedBase64 = bytesToBase64(prepared);
  // 5. Bound and validate the graph before anything walks it: the decoder
  //    below, and the upstream recursive hasher after it.
  const graph = guardPreparedTransaction(preparedBase64);
  if (!graph.ok) {
    return fail(
      "invalid_exact_canton_malformed_payload",
      "invalid_prepared_transaction_structure",
      undefined,
      graph.reason,
    );
  }
  // 6. The signed transfer. Its sender is the payer (spec Rule 8): the payload
  //    names none, so every result from here on reports this one.
  const transfer = decodePreparedTransaction(preparedBase64);
  if (!transfer) {
    return fail("invalid_exact_canton_malformed_payload", "transfer_mismatch", undefined, "undecodable");
  }
  const payer = transfer.sender;
  // 7. public key well-formed (32-byte Ed25519). Malformed key bytes are
  //    indistinguishable from "no usable key" here → missing_public_key. A
  //    key that is not one cannot have signed, so the spec's code is
  //    signature_invalid.
  let derivedFingerprint: string;
  try {
    derivedFingerprint = fingerprintForPublicKey(inner.publicKey);
  } catch {
    return fail("invalid_exact_canton_signature_invalid", "missing_public_key", payer);
  }
  // 8. the key must be the sender's: its fingerprint must match the sender
  //    party's `::<fingerprint>` suffix. Without this, any key could sign a
  //    transfer that names another party as the sender.
  const partySuffix = payer.split("::")[1];
  if (!partySuffix || derivedFingerprint.toLowerCase() !== partySuffix.toLowerCase()) {
    return fail("invalid_exact_canton_signature_invalid", "bad_fingerprint", payer);
  }
  // 9. Validate the prepared-transaction hash and signature encodings.
  //    `signature` is canonical base64, while `preparedTxHash` is canonical
  //    lowercase hex. The hash is keyed on the facilitator's submissionId,
  //    so alternate spellings of the same bytes are refused.
  const signatureHex = signatureFromBase64(inner.signature);
  if (!PREPARED_TX_HASH.test(inner.preparedTxHash) || signatureHex === null) {
    return fail("invalid_exact_canton_signature_invalid", "bad_signature", payer);
  }

  // 10. An absent hashingSchemeVersion means V2. The spec answers one this
  //     verifier does not implement with malformed_payload.
  const hashingSchemeVersion =
    inner.hashingSchemeVersion ?? HashingSchemeVersion.V2;

  if (hashingSchemeVersion !== HashingSchemeVersion.V2) {
    return fail("invalid_exact_canton_malformed_payload", "internal_error", payer);
  }

  // 11. Derive the trusted hash from the validated prepared transaction.
  let computedHash: string;
  try {
    computedHash = await computePreparedTransactionHash(
      preparedBase64,
      hashingSchemeVersion,
    );
  } catch {
    return fail("invalid_exact_canton_malformed_payload", "transfer_mismatch", payer, "undecodable");
  }

  // 12. The supplied hash must describe this exact transaction (Rule 3, so
  //     signature_invalid in the spec's terms).
  if (computedHash.toLowerCase() !== inner.preparedTxHash.toLowerCase()) {
    return fail("invalid_exact_canton_signature_invalid", "prepared_transaction_hash_mismatch", payer);
  }

  // 13. Verify the payload's base64 signature against the trusted hash.
  if (!verifySignature(computedHash, signatureHex, inner.publicKey)) {
    return fail("invalid_exact_canton_signature_invalid", "bad_signature", payer);
  }

  // 14. The signed transfer must actually move what the requirements demand.
  //     This is the payload's one binding to the requirements: the signature
  //     covers the prepared transaction, so checking receiver/instrument/amount
  //     rejects a valid signature over a divergent transfer (e.g. to another
  //     party, or a smaller amount).
  const mismatch = findTransferMismatch(transfer, requirements);
  if (mismatch) return fail(MISMATCH_REASON[mismatch], "transfer_mismatch", payer, mismatch);
  // 15. the exercise must go through a real transfer factory, proved from the
  //     transaction's own input contracts. Placed after 14 because it reads
  //     the admin that step has just held equal to the requirements', so the
  //     two cannot disagree about which instrument this is.
  const factory = factoryProofFailure(transfer);
  if (factory) return fail("invalid_exact_canton_malformed_payload", "transfer_mismatch", payer, factory);
  // 15b. no contract the SENDER signs may be created without the instrument's
  //      admin on it. Such a contract hands the payer's authority to whoever
  //      controls its choices, and nothing else here would notice: the quoted
  //      payment can be delivered perfectly while it is left behind.
  const created = createFailure(transfer);
  if (created) return fail("invalid_exact_canton_malformed_payload", "transfer_mismatch", payer, created);
  // 16. the transfer must DELIVER, not leave a pending instruction. Which of
  //     the two a signed TransferFactory_Transfer does is visible only in its
  //     consequences, and relaying a pending one commits the payer's funds
  //     without paying the merchant.
  const delivery = deliveryFailure(transfer, requirements);
  if (delivery) {
    return fail("invalid_exact_canton_preapproval_missing", "transfer_mismatch", payer, delivery);
  }
  // 17. the transfer must still be executable. An absent deadline counts as
  //     expired: `executeBefore` is not optional in a real transfer, and
  //     reading a missing one as "no deadline" would make the check skippable
  //     by leaving the field out.
  if (isTransferExpired(transfer.executeBeforeMicros)) {
    return fail("invalid_exact_canton_expired", "transfer_expired", payer);
  }
  return { isValid: true, payer };
}

/**
 * The transfer a payload's `preparedTransaction` authorizes: base64 of one gzip
 * member, gunzipped and decoded. `null` when it is malformed or over either
 * bound, which is as undecodable as a bad protobuf. Its `sender` is the
 * payment's payer (spec Rule 8), since the payload names none. Takes untrusted
 * input, so a value that is not a string is `null` too, not a throw.
 */
export function decodePayloadTransfer(preparedTransaction: string): DecodedTransfer | null {
  if (typeof preparedTransaction !== "string") return null;
  const prepared = gunzipPreparedTransaction(preparedTransaction);
  return prepared && decodePreparedTransaction(bytesToBase64(prepared));
}

/**
 * Check a decoded transfer against the requirements. Returns `null` when the
 * transfer satisfies them, or a short field detail (`"receiver" | "instrument" |
 * "amount" | "memo"`) naming the first divergence. The verifier answers with
 * the spec's code for that field, and the field in `extensions.detail`. The amount must be EQUAL,
 * not merely sufficient (Rule 4), and the two sides are in different units — the
 * transfer carries an on-ledger Decimal, the requirements an atomic integer at
 * the Token Standard's fixed scale.
 */
export function findTransferMismatch(
  transfer: DecodedTransfer,
  requirements: CantonPaymentRequirements,
): "receiver" | "instrument" | "amount" | "memo" | "synchronizer" | null {
  // No sender check: the sender is the payer by definition (spec Rule 8), and
  // the verifier has already bound the signing key to it by fingerprint.
  // Rule 12, both ways. The spec only requires the check when the merchant
  // quotes a memo, but `x402.memo` is a key the scheme reserves, not the
  // payer's own namespace — its own references go under its own key, which is
  // where the wallet SDK already writes them. So an unquoted transfer must
  // carry no memo either: a merchant that reconciles ledger payments by memo
  // would otherwise credit whichever order a payer chose to name, paying a
  // cheap resource to settle an expensive one.
  if (transfer.memo !== requirements.extra.memo) return "memo";
  // The domain the payer prepared for, from the signed block, so it is theirs
  // to commit. Without it a payment lands on whatever synchronizer the
  // transfer names, which need not be one the merchant settles on.
  if (!synchronizerMatches(transfer.synchronizerId, requirements.extra.synchronizerId)) {
    return "synchronizer";
  }
  if (transfer.receiver !== requirements.payTo) return "receiver";
  // From `extra`, not `asset`: the latter is only a symbol, which cannot say
  // which registry issued the instrument.
  const want = requirements.extra.instrumentId;
  if (transfer.instrumentId.id !== want.id || transfer.instrumentId.admin !== want.admin) {
    return "instrument";
  }
  // EQUAL, not at-least (Rule 4). The two sides are in different units, so both
  // become atomic: the transfer carries an on-ledger Decimal, the quote an
  // atomic integer. One scale for every instrument — see WIRE_DECIMALS.
  const moved = ledgerToAtomic(transfer.amount, WIRE_DECIMALS);
  const quoted = isValidAmount(requirements.amount) ? BigInt(requirements.amount) : null;
  if (moved === null || quoted === null || moved !== quoted) return "amount";
  return null;
}

/**
 * Build a canton-exact {@link SchemeVerifier} bound to one Canton network (a
 * `canton:<name>` — see ../networks). The registry dispatches on
 * `(schemeId, networkId)`.
 *
 * Accepts that scheme id and that network id only; there is no alias set.
 */
export function createCantonExactVerifier(networkId: NetworkId): SchemeVerifier {
  return {
    schemeId: EXACT_SCHEME_ID,
    networkId,
    verify: (payload, requirements) => verifyCantonExact(networkId, payload, requirements),
  };
}
