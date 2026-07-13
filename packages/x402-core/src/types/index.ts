// x402 exact-canton wire types — the canonical contract shared by the client SDK
// and the facilitator server. Spec: canton-x402 spec §5–§6.
//
// v2 (exact-canton) only; legacy v1 shapes are intentionally not carried over.
// Organized by domain: common (shared kernel) · requirements · payment ·
// facilitator (verify/settle/supported) · payment-object.
//
// FUTURE (multi-scheme generics — not yet applied): the types here are bound to
// the single exact-canton scheme. When a SECOND scheme lands (batch-settlement /
// USDCx), lift a chain-agnostic layer and keep the Canton types as thin aliases:
//
//   interface X402PaymentPayload<TInner> { x402Version; scheme; network; payload: TInner }
//   interface X402PaymentRequirements<TAsset, TExtra> { …; asset: TAsset; extra?: TExtra }
//   interface X402Request<TInner, TAsset, TExtra> { paymentPayload; paymentRequirements }
//   type CantonPaymentPayload      = X402PaymentPayload<CantonPaymentInner>
//   type CantonPaymentRequirements = X402PaymentRequirements<AssetSpec>
//
// Chain-specific seams: the payload's ENTIRE `payload` object (→ TInner); in
// requirements the ONLY chain-specific field is `asset` (→ TAsset); scheme-specific
// `extra` (→ TExtra). Use defaulted type params so existing call sites don't change.
// Also pending (markers inline): `scheme` open union; reason-union open-vs-closed.
// Factor against the REAL second-scheme shapes, not speculatively.

export * from "./common";
export * from "./requirements";
export * from "./payment";
export * from "./facilitator";
export * from "./payment-object";
