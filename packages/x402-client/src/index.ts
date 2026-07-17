/**
 * @chainsafe/x402-client
 *
 * Chain-agnostic client for a Canton x402 facilitator. Speaks only the x402 wire
 * protocol (verify / settle / supported over the envelopes from @chainsafe/x402-core),
 * so any payer — the server SDK, a browser fetch wrapper, other tooling — reuses it.
 */
export const VERSION = "0.0.1";
export * from "./facilitator";
