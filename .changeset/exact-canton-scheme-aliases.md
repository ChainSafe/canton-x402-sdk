---
"@chainsafe/x402-core": minor
---

`createExactCantonVerifier` takes the scheme id it advertises, and a list of ids
it also accepts — so a deployment can migrate to the identifier the registered
Canton scheme spec fixes (`exact`) without breaking clients still paying
`exact-canton`.

The verifier hard-checked one scheme id and one network id, so aliasing in a
facilitator's dispatcher could not work: the request reached the verifier and
failed `scheme_mismatch` one layer down.

Three stages, each a configuration change rather than a code change:

```ts
// now — advertise and accept the id we always have
createExactCantonVerifier(net);

// during — lead with the spec's id, keep paying clients working
createExactCantonVerifier(net, {
  schemeId: EXACT_SCHEME_ID,
  acceptSchemes: [EXACT_CANTON_SCHEME_ID],
});

// after — drop the legacy id by deleting one line
createExactCantonVerifier(net, { schemeId: EXACT_SCHEME_ID });
```

Accept many, advertise one: `schemeId` / `networkId` on the returned verifier are
what the registry dispatches on and what `/supported` publishes, so a client is
never left guessing which of several ids is the real one. Payload and requirements
must still name the *same* id — both being accepted does not make them
interchangeable within one payment.

`acceptNetworks` is the same migration for network ids — lead with a registered
id while a synchronizer hash is still quoted, then drop the hash. The registered
ids the spec fixes are now constants too: `SPEC_MAINNET_NETWORK`,
`SPEC_TESTNET_NETWORK` and `SPEC_DEVNET_NETWORK` in `networks.ts`, beside the
`canton:<fingerprint>` ids they will replace. They are names, not a mapping —
which deployment answers to which is the deployment's business.
Both dimensions ship together because they reshape one exported options type,
and splitting them would mean two minor releases of the same idea.

`EXACT_CANTON_SCHEME_ID` and `EXACT_SCHEME_ID` are now exported. Every option
defaults to today's behaviour, so a caller that passes nothing is unaffected.
