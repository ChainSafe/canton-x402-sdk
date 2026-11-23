import * as v from "valibot";
import { CantonPaymentPayloadSchema, X402PaymentEnvelopeSchema } from "./payment";
import {
  CantonPaymentRequirementsSchema,
  X402PaymentRequirementsEnvelopeSchema,
} from "./requirements";
import { InstrumentIdSchema } from "./common";
import type { NetworkId, X402Version } from "./common";
import type { CantonPaymentInner, X402PaymentPayload } from "./payment";
import type { X402PaymentRequirements } from "./requirements";

/**
 * Generic request body for POST /v2/verify and /v2/settle — payload + requirements,
 * parameterized by the same scheme seams: `TExtra` is both the requirements' and
 * the payment's `accepted`'s. Generic → type-only; the concrete canton-exact
 * request below is schema-first.
 */
export interface X402Request<TInner = CantonPaymentInner, TExtra = Record<string, unknown>> {
  x402Version: X402Version;
  paymentPayload: X402PaymentPayload<TInner, TExtra>;
  paymentRequirements: X402PaymentRequirements<TExtra>;
}

/** canton-exact verify/settle request. Settle takes the identical envelope. */
export const VerifyRequestSchema = v.object({
  x402Version: v.literal(2),
  paymentPayload: CantonPaymentPayloadSchema,
  paymentRequirements: CantonPaymentRequirementsSchema,
});
export type VerifyRequest = v.InferOutput<typeof VerifyRequestSchema>;
export type SettleRequest = VerifyRequest;

/** canton-exact verify/settle request guard + parser (schema-derived, concrete). */
export function isCantonVerifyRequest(x: unknown): x is VerifyRequest {
  return v.is(VerifyRequestSchema, x);
}
export function parseCantonVerifyRequest(input: unknown): VerifyRequest {
  return v.parse(VerifyRequestSchema, input);
}

/**
 * Loose validator for the verify/settle request envelope: the universal fields
 * only — x402 v2, a payment envelope, and the requirements fields shared by every
 * scheme. Scheme-agnostic: a multi-scheme dispatcher validates/parses the envelope
 * with this, then the per-scheme verifier checks the concrete inner (use
 * {@link isCantonVerifyRequest} for canton-exact).
 */
const X402RequestEnvelopeSchema = v.looseObject({
  x402Version: v.literal(2),
  paymentPayload: X402PaymentEnvelopeSchema,
  paymentRequirements: X402PaymentRequirementsEnvelopeSchema,
});
export function isX402Request(x: unknown): x is X402Request<unknown, unknown> {
  return v.is(X402RequestEnvelopeSchema, x);
}
export function parseX402Request(input: unknown): X402Request<unknown, unknown> {
  return v.parse(X402RequestEnvelopeSchema, input) as unknown as X402Request<unknown, unknown>;
}

/**
 * What the CALLER resolves before a Canton `exact` payment can be verified.
 * The mirror of `extensions` on the way out: facts in, facts out, both
 * scheme-shaped.
 */
export interface CantonVerifyContext {
  /**
   * The payer party's PUBLIC signing keys, STANDARD base64 Ed25519 — not
   * base64url, which is what a JWKS `x` is: most keys spell differently in the
   * two, and an undecodable one is silently just a key that did not sign.
   *
   * Read from the ledger by the caller, because the payload carries none and
   * the payer is the transfer's sender ({@link decodePayloadTransfer}). A
   * party may publish several and the payload does not say which signed, so
   * any one verifying is the party verifying; none refuses the payment. Which
   * one did verify comes back as `extensions.signedBy`.
   */
  payerPublicKeys: readonly string[];
  /**
   * The registry infrastructure parties trusted for each registrar, keyed by
   * the registrar's party id (an instrument's `instrumentId.admin`). For the
   * DA Registry Utility, that is its operator and the token's provider.
   *
   * Spec Rule 7 trusts such a party only when the facilitator is configured
   * with it for that registrar. So for a registry token (any instrument but
   * Canton Coin), each signatory of the `TransferRule` the payment delivers
   * through, the rule's own `operator` and `provider`, and each input
   * holding's `operator` and `provider` must be the registrar itself or one
   * of the parties listed for it. They are compared as a set, not by role:
   * the list says who is trusted, not which field each one fills.
   *
   * It is also what spec Rule 3's registry check reads. A registry token's
   * transfer must exercise the receiver's own registry `TransferPreapproval`
   * (`Utility.Registry.App.V0.Model.TransferPreapproval`), signed by `payTo`
   * alone and naming `payTo` as receiver and the instrument's admin, for a
   * registrar with an entry here. Otherwise verify answers
   * `invalid_exact_canton_malformed_payload` with a `factory_` detail:
   * `factory_not_preapproval` when the payee has no preapproval at all, and
   * `factory_registry_unconfigured` for a registrar with no entry, which this
   * check reaches before the one above.
   *
   * Optional, and OPT-IN. Leave it out (or pass `undefined`) and neither
   * check runs, as before they existed: registry infrastructure parties and a
   * registry token's factory are then not checked at all. Pass it — even `{}` — and it is authoritative: a
   * registrar with no entry is one nobody configured, and its tokens are
   * refused. So are they when the value is not an object at all, or when the
   * registrar's entry is not a list; members of a list that are not strings
   * are ignored. Canton Coin ignores the field.
   */
  registryParties?: Readonly<Record<string, readonly string[]>>;
}

/**
 * The pure verification contract every scheme implements. Core owns it as the
 * single source of truth; the facilitator and any client conform to it. Method
 * interface → type-only.
 *
 * The payload and requirements are the widest envelope (`unknown` inner and
 * `extra`), so a heterogeneous registry of verifiers type-checks and each
 * verifier narrows via its own guard. `TContext` is the same idea for what the
 * caller must resolve first — a registry holds `SchemeVerifier` (context
 * `unknown`), while a concrete verifier still type-checks its own callers.
 */
export interface SchemeVerifier<TContext = unknown> {
  readonly schemeId: string;
  /** The concrete network this verifier is bound to, e.g. `canton:devnet`. */
  readonly networkId: NetworkId;
  /**
   * Is this payment valid for these requirements? Answers rather than throws, so
   * a malformed payload is a refusal. Pure: replay, policy and settlement stay
   * with the caller.
   *
   * `context` is whatever this scheme needs looked up first — for Canton
   * `exact`, {@link CantonVerifyContext}. A verifier narrows it with its own
   * guard, exactly as it does the payload.
   */
  verify(
    payload: X402PaymentPayload<unknown, unknown>,
    requirements: X402PaymentRequirements<unknown>,
    context: TContext,
  ): Promise<VerifyResponse>;
}

/**
 * The reason codes the specs define: the Canton `exact` scheme's Error Reason
 * Codes table, then the x402 v2 general codes (§9) other than the EVM scheme's.
 * The scheme's table is not split by endpoint, so verify and settle both take
 * all of them.
 */
const SPEC_REASONS = [
  "invalid_exact_canton_missing_proof",
  "invalid_exact_canton_malformed_payload",
  "invalid_exact_canton_signature_invalid",
  "invalid_exact_canton_amount_mismatch",
  "invalid_exact_canton_merchant_mismatch",
  "invalid_exact_canton_instrument_id_mismatch",
  "invalid_exact_canton_preapproval_missing",
  "invalid_exact_canton_fee_payer_mismatch",
  "invalid_exact_canton_expired",
  "invalid_exact_canton_execute_before_too_far",
  "invalid_exact_canton_insufficient_inputs",
  "invalid_exact_canton_memo_mismatch",
  "invalid_exact_canton_merchant_not_registered",
  "invalid_exact_canton_self_payment",
  "invalid_exact_canton_execute_failed",
  "unexpected_canton_ledger_error",
  "settlement_pending",
  "invalid_network",
  "unsupported_scheme",
  "insufficient_funds",
  "invalid_payload",
  "invalid_payment_requirements",
  "invalid_scheme",
  "invalid_x402_version",
  "invalid_transaction_state",
  "unexpected_verify_error",
  "unexpected_settle_error",
] as const;

/**
 * Codes this implementation answers with that the scheme spec does not define.
 * Only one: the spec names `extra.synchronizerId` but binds no rule to it, so
 * there is no code to borrow.
 *
 * Kept out of SPEC_REASONS so that list stays the spec's table and nothing
 * else — a client written against the spec will not match on this. Both lists
 * are spread into the picklists below, so the wire union is unchanged. When
 * the upstream rule lands this moves across.
 */
const CANTON_EXACT_EXTENSION_REASONS = ["invalid_exact_canton_synchronizer_mismatch"] as const;

/** A code this implementation adds beyond the spec's table. */
export type CantonExactExtensionReason = (typeof CANTON_EXACT_EXTENSION_REASONS)[number];

/** The scheme's codes alone, for a slot where only one of those belongs. */
export type SpecVerifyInvalidReason = (typeof SPEC_REASONS)[number];

/**
 * Why a payment is invalid: the spec's code, the one a client written against
 * the spec matches on. Which of a code's causes it was goes in
 * `extensions.detail`, not here.
 *
 * The specs' codes plus the one declared extension, and nothing else. The
 * older codes were dropped before 1.0.0, so an answer from a facilitator on a
 * published 0.1.x carrying one of them no longer parses. From 1.0.0 this list
 * can only grow in a minor.
 */
export const VerifyInvalidReasonSchema = v.picklist([
  ...SPEC_REASONS,
  ...CANTON_EXACT_EXTENSION_REASONS,
]);
export type VerifyInvalidReason = v.InferOutput<typeof VerifyInvalidReasonSchema>;

/** Scheme-specific extra fields (mirrors upstream x402 v2 `extensions`). */
const ExtensionsSchema = v.record(v.string(), v.unknown());

export const VerifyResponseValidSchema = v.object({
  isValid: v.literal(true),
  payer: v.optional(v.string()),
  extensions: v.optional(ExtensionsSchema),
  /** Scheme-specific data, as x402 v2 §5.4.2 gives a verify answer. */
  extra: v.optional(ExtensionsSchema),
});
export type VerifyResponseValid = v.InferOutput<typeof VerifyResponseValidSchema>;

export const VerifyResponseInvalidSchema = v.object({
  isValid: v.literal(false),
  invalidReason: VerifyInvalidReasonSchema,
  /**
   * Human-readable text for `invalidReason`. Free text that can change between
   * facilitators, so match on the code, never on this (x402 v2 §9).
   */
  invalidMessage: v.optional(v.string()),
  payer: v.optional(v.string()),
  extensions: v.optional(ExtensionsSchema),
  /** Scheme-specific data, as x402 v2 §5.4.2 gives a verify answer. */
  extra: v.optional(ExtensionsSchema),
});
export type VerifyResponseInvalid = v.InferOutput<typeof VerifyResponseInvalidSchema>;

/** Discriminated on `isValid`. */
export const VerifyResponseSchema = v.variant("isValid", [
  VerifyResponseValidSchema,
  VerifyResponseInvalidSchema,
]);
export type VerifyResponse = v.InferOutput<typeof VerifyResponseSchema>;

/** Why a settle failed: the same list as verify's, the specs' codes plus the one extension. */
export const SettleErrorReasonSchema = v.picklist([
  ...SPEC_REASONS,
  ...CANTON_EXACT_EXTENSION_REASONS,
]);
export type SettleErrorReason = v.InferOutput<typeof SettleErrorReasonSchema>;

export const SettleResponseSuccessSchema = v.object({
  success: v.literal(true),
  network: v.string(),
  /** Canton updateId of the executed transaction. */
  transaction: v.string(),
  /** Optional in x402 v2, so a facilitator may leave it out. */
  payer: v.optional(v.string()),
  /** The amount settled, in atomic units, as the requirements' `amount` is. */
  amount: v.optional(v.string()),
  extensions: v.optional(ExtensionsSchema),
});
export type SettleResponseSuccess = v.InferOutput<typeof SettleResponseSuccessSchema>;

export const SettleResponseErrorSchema = v.object({
  success: v.literal(false),
  errorReason: SettleErrorReasonSchema,
  /**
   * Human-readable text for `errorReason`. Free text that can change between
   * facilitators, so match on the code, never on this (x402 v2 §9). Which of a
   * code's causes it was goes in `extensions.detail`, as on verify.
   */
  errorMessage: v.optional(v.string()),
  /**
   * The transaction the answer is about. Empty when nothing was relayed. On
   * `settlement_pending` it is the payment's `preparedTxHash`: the relay went
   * out and its outcome is not known yet.
   */
  transaction: v.string(),
  network: v.string(),
  payer: v.optional(v.string()),
  extensions: v.optional(ExtensionsSchema),
});
export type SettleResponseError = v.InferOutput<typeof SettleResponseErrorSchema>;

/**
 * True for a `settlement_pending` answer: the transaction was relayed and may
 * still commit, so the payment must not be treated as failed and the payer
 * must not be asked to sign again. The spec requires such an answer to carry a
 * non-empty `transaction` and `network`; one missing either of them, or with
 * either empty, is read as a plain failure.
 *
 * Both are checked at runtime even though the type requires them: the client
 * hands back the facilitator's body without validating it.
 */
export function isSettlementPending(
  response: SettleResponse,
): response is SettleResponseError & { errorReason: "settlement_pending" } {
  return (
    !response.success &&
    response.errorReason === "settlement_pending" &&
    typeof response.transaction === "string" &&
    response.transaction !== "" &&
    typeof response.network === "string" &&
    response.network !== ""
  );
}

/** Discriminated on `success`. */
export const SettleResponseSchema = v.variant("success", [
  SettleResponseSuccessSchema,
  SettleResponseErrorSchema,
]);
export type SettleResponse = v.InferOutput<typeof SettleResponseSchema>;

export const SupportedKindSchema = v.object({
  x402Version: v.literal(2),
  scheme: v.string(),
  network: v.string(),
  extra: v.optional(ExtensionsSchema),
});
export type SupportedKind = v.InferOutput<typeof SupportedKindSchema>;

export const SupportedResponseSchema = v.object({
  kinds: v.array(SupportedKindSchema),
  /**
   * The ids of the extensions the facilitator implements (x402 v2 §7.3.1). A
   * list of ids, not the `extensions` object an answer carries.
   */
  extensions: v.array(v.string()),
  /** The facilitator's signers, keyed by CAIP-2 pattern such as `canton:*`. */
  signers: v.record(v.string(), v.array(v.string())),
});
export type SupportedResponse = v.InferOutput<typeof SupportedResponseSchema>;

/**
 * Thrown when a kind's `extra` is not a canton-exact one: a key this scheme
 * defines is missing or the wrong shape. Named for the cause, since the caller
 * can do nothing about it but tell whoever runs the facilitator.
 */
export class MalformedSupportedExtraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedSupportedExtraError";
  }
}

/**
 * One instrument a deployment settles, as `kinds[].extra.instruments[]` carries
 * it.
 *
 * `admin` repeats `instrumentId.admin`: the registered scheme names the admin
 * party at the top level, and the Splice instrument id carries it too. Both are
 * read, and {@link selectCantonDeployments} refuses a response where the two
 * disagree, since it is then inconsistent about who validates the holding.
 */
export const SupportedInstrumentSchema = v.looseObject({
  admin: v.optional(v.string()),
  instrumentId: v.optional(InstrumentIdSchema),
  /** Display symbol, e.g. `CC`. */
  symbol: v.optional(v.string()),
});
export type SupportedInstrument = v.InferOutput<typeof SupportedInstrumentSchema>;

/**
 * The canton-exact reading of `kinds[].extra`.
 *
 * `extra` is Optional and scheme-defined in x402 v2 §7.3, so what is in there is
 * this scheme's business. Every field is optional and unknown keys pass: a
 * conforming facilitator may omit any of this, and `extra` is where other
 * deployments put their own keys. Nothing here is trusted to exist — the reader
 * says so when something it needs is missing, instead of taking `undefined` for
 * a value.
 */
export const CantonSupportedExtraSchema = v.looseObject({
  /** Asset transfer methods this deployment speaks, e.g. `transfer-factory`. */
  transferMethods: v.array(v.pipe(v.string(), v.minLength(1))),
  /** The synchronizer it submits to — the id a payer prepares against. */
  synchronizerId: v.pipe(v.string(), v.minLength(1)),
  /** How a prepared transaction travels, e.g. `inline`. */
  carriages: v.array(v.pipe(v.string(), v.minLength(1))),
  /**
   * The relayer a merchant quotes as `extra.feePayer`. Optional here: a
   * facilitator advertises it only once a party is configured.
   */
  feePayer: v.optional(v.pipe(v.string(), v.minLength(1))),
  /**
   * The instruments this deployment lists. Optional: what an absent, empty or
   * unusable list means is the reader's, not the shape's — see
   * {@link selectCantonDeployments}.
   */
  instruments: v.optional(v.array(SupportedInstrumentSchema)),
});
export type CantonSupportedExtra = v.InferOutput<typeof CantonSupportedExtraSchema>;

/**
 * Read one kind's `extra` as canton-exact, or say what is wrong with it.
 *
 * Throws rather than returning `{}`, which is what it did before: swallowing
 * the failure meant one bad field discarded every good one — the synchronizer
 * and the instruments alongside it — and the caller was then told the
 * deployment "advertises no instrument", which was both false and unactionable.
 *
 * Unknown keys still pass: `extra` is where a deployment puts its own, and only
 * the keys this scheme defines are checked.
 */
export function cantonSupportedExtra(kind: SupportedKind): CantonSupportedExtra {
  const parsed = v.safeParse(CantonSupportedExtraSchema, kind.extra ?? {});
  if (parsed.success) return parsed.output;
  const problems = parsed.issues
    .map((i) => `${["extra", ...(i.path ?? []).map((p) => String(p.key))].join(".")}: ${i.message}`)
    .join("; ");
  throw new MalformedSupportedExtraError(
    `facilitator kind ${kind.scheme}/${kind.network} does not advertise a canton-exact extra — ${problems}`,
  );
}
