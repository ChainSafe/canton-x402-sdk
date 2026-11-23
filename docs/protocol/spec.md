# Protocol spec

The wire format: schemes, networks, requirements, payloads and their hashing.
The SDK implements these specifications, published by the x402 Foundation:

- [x402 v2 specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md): payment requirements, the payment payload, and the facilitator's verify, settle and supported answers.
- [HTTP transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md): the `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` and `PAYMENT-RESPONSE` headers.
- [Canton `exact` scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_canton.md): what a Canton payment carries and the rules a facilitator verifies it against.
