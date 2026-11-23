# SDK APIs

Every export of the four packages, generated from their source by TypeDoc each
time the site is built, so it matches the release the site was published for.
The guides explain how the pieces fit together; this is where to look up a
signature.

| Package                                                          | What it's for                                                                        | Guide                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------ |
| [`@chainsafe/x402-express`](/api/@chainsafe/x402-express/)       | Gate Express routes behind a payment.                                                | [Express middleware](/guides/express-middleware) |
| [`@chainsafe/x402-server-sdk`](/api/@chainsafe/x402-server-sdk/) | Pay for an x402 API from Node: `createX402Fetch` and the Canton payer.               | [Payer SDK](/guides/payer-sdk)                   |
| [`@chainsafe/x402-client`](/api/@chainsafe/x402-client/)         | Call a facilitator's `/v2/verify`, `/v2/settle` and `/v2/supported` directly.        | [Facilitator client](/guides/facilitator-client) |
| [`@chainsafe/x402-core`](/api/@chainsafe/x402-core/)             | The shared wire types, header codecs, error codes, and verifying a payment yourself. | [Error codes](/reference/error-codes)            |
