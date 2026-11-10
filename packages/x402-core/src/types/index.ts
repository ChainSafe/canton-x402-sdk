// x402 canton-exact wire types — the canonical contract shared by the client SDK
// and the facilitator server. Spec: canton-x402 spec §5–§6.
//
// v2 (canton-exact) only; legacy v1 shapes are intentionally not carried over.
// Organized by domain: common (shared kernel) · requirements · payment ·
// facilitator (verify/settle/supported) · payment-object.
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

export * from "./common";
export * from "./requirements";
export * from "./payment";
export * from "./facilitator";
export * from "./payment-object";
