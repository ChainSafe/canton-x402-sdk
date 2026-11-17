// x402 canton-exact wire types — the canonical contract shared by the client SDK
// and the facilitator server. Spec: canton-x402 spec §5–§6.
//
// v2 (canton-exact) only; legacy v1 shapes are intentionally not carried over.
// Organized by domain: common (shared kernel) · requirements · payment ·
// facilitator (verify/settle/supported).
//
// Multi-scheme generics: the chain-agnostic bases carry the scheme seams
// via defaulted type params, and the canton-exact types are thin aliases —
//
//   interface X402PaymentPayload<TInner,TExtra> { x402Version; accepted: X402PaymentRequirements<TExtra>; payload: TInner; resource?; extensions? }
//   type X402PaymentRequirements<TExtra>        = { …; asset: string; extra?: TExtra }
//   interface X402Request<TInner,TExtra>        { paymentPayload; paymentRequirements }
//   type CantonPaymentPayload      = X402PaymentPayload<CantonPaymentInner>
//
// Seams: the payload's ENTIRE `payload` object (TInner), and requirements' `extra`
// (TExtra), which is also the payment's `accepted.extra`: X402Request passes one
// TExtra to both. A new scheme instantiates these with its own shapes — no
// `as unknown as` casts. `asset` is NOT a seam: the spec types it as a string for
// every scheme, so whatever a string cannot carry belongs in `extra`.
//
// CantonPaymentRequirements is not an alias of the generic — it is schema-first
// (one valibot definition giving shape, validator and type).
//
// Still pending (markers inline): reason-union open-vs-closed; branded DecimalString;
// per-scheme `CantonNetworkId` narrowing (needs a TNetwork seam).

export {
  ASSET_TRANSFER_METHOD,
  AssetSpecSchema,
  InstrumentIdSchema,
  PaymentExtensionsSchema,
  ResourceInfoSchema,
} from "./common";
export type {
  AssetSpec,
  InstrumentId,
  NetworkId,
  PaymentExtensions,
  ResourceInfo,
  Scheme,
  X402Version,
} from "./common";
export {
  CantonPaymentRequiredResponseSchema,
  CantonPaymentRequirementsSchema,
  CantonRequirementsExtraSchema,
  X402PaymentRequiredResponseEnvelopeSchema,
  X402PaymentRequirementsEnvelopeSchema,
  isCantonPaymentRequiredResponse,
  isCantonPaymentRequirements,
  isX402PaymentRequiredResponse,
  isX402PaymentRequirements,
  parseCantonPaymentRequirements,
} from "./requirements";
export type {
  CantonPaymentRequiredResponse,
  CantonPaymentRequirements,
  CantonRequirementsExtra,
  X402PaymentRequiredResponse,
  X402PaymentRequirements,
} from "./requirements";
export {
  CantonPaymentInnerSchema,
  CantonPaymentPayloadSchema,
  HashingSchemeVersion,
  X402PaymentEnvelopeSchema,
  isCantonPaymentInner,
  isCantonPaymentPayload,
  isX402PaymentPayload,
  parseCantonPaymentInner,
  parseCantonPaymentPayload,
} from "./payment";
export type {
  CantonPaymentInner,
  CantonPaymentPayload,
  X402PaymentPayload,
} from "./payment";
export {
  CantonSupportedExtraSchema,
  MalformedSupportedExtraError,
  SettleErrorReasonSchema,
  SettleResponseErrorSchema,
  SettleResponseSchema,
  SettleResponseSuccessSchema,
  SupportedInstrumentSchema,
  SupportedKindSchema,
  SupportedResponseSchema,
  VerifyInvalidReasonSchema,
  VerifyRequestSchema,
  VerifyResponseInvalidSchema,
  VerifyResponseSchema,
  VerifyResponseValidSchema,
  cantonSupportedExtra,
  isCantonVerifyRequest,
  isX402Request,
  parseCantonVerifyRequest,
  parseX402Request,
} from "./facilitator";
export type {
  CantonExactExtensionReason,
  CantonSupportedExtra,
  SchemeVerifier,
  SettleErrorReason,
  SettleRequest,
  SettleResponse,
  SettleResponseError,
  SettleResponseSuccess,
  SpecVerifyInvalidReason,
  SupportedInstrument,
  SupportedKind,
  SupportedResponse,
  VerifyInvalidReason,
  VerifyRequest,
  VerifyResponse,
  VerifyResponseInvalid,
  VerifyResponseValid,
  X402Request,
} from "./facilitator";
