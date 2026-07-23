// x402 exact-canton wire types — the canonical contract shared by the client SDK
// and the facilitator server. Spec: canton-x402 spec §5–§6.
//
// v2 (exact-canton) only; legacy v1 shapes are intentionally not carried over.
// Organized by domain: common (shared kernel) · requirements · payment ·
// facilitator (verify/settle/supported) · payment-object.
//
// Multi-scheme generics: the chain-agnostic bases carry the scheme seams
// via defaulted type params, and the exact-canton types are thin aliases —
//
//   interface X402PaymentPayload<TInner>            { x402Version; scheme; network; payload: TInner }
//   interface X402PaymentRequirements<TAsset,TExtra> { …; asset: TAsset; extra?: TExtra }
//   interface X402Request<TInner,TAsset,TExtra>     { paymentPayload; paymentRequirements }
//   type CantonPaymentPayload      = X402PaymentPayload<CantonPaymentInner>
//   type CantonPaymentRequirements = X402PaymentRequirements<AssetSpec>
//
// Seams: the payload's ENTIRE `payload` object (TInner); requirements' `asset`
// (TAsset) + `extra` (TExtra). A new scheme instantiates these with its own shapes
// — no `as unknown as` casts. Defaults = the Canton types, so call sites using the
// aliases (and `X402*` without args) are unchanged.
//
// Still pending (markers inline): `scheme` open union; reason-union open-vs-closed.

export * from "./common";
export * from "./requirements";
export * from "./payment";
export * from "./facilitator";
export * from "./payment-object";
