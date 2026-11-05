import { describe, it, expect } from "vitest";
import { getPublicKey, hashes } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  atomicToLedger,
  createCantonExactVerifier,
  createVerifierRegistry,
  EXACT_SCHEME_ID,
  fingerprintForPublicKey,
  signHash,
} from "./index";
import { requirementsHash } from "../hashing";
import { encodeNode, encodePreparedTransaction, wrap } from "./prepared-tx.fixtures";
import type {
  CantonPaymentPayload,
  CantonPaymentRequirements,
  SchemeVerifier,
} from "../index";
import { DEVNET_NETWORK, MAINNET_NETWORK } from "../networks";

hashes.sha512 = sha512;

const NETWORK = DEVNET_NETWORK;
const toB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

// A deterministic payer keypair + a well-formed, correctly-signed payload for it.
function buildSignedFixture(overrides: { executeBeforeSeconds?: number; memo?: string } = {}) {
  const executeBeforeSeconds = overrides.executeBeforeSeconds ?? 120;
  const seed = new Uint8Array(32).fill(3);
  const pub = getPublicKey(seed);
  const pubB64 = toB64(pub);
  const fingerprint = fingerprintForPublicKey(pubB64);
  const payer = `alice::${fingerprint}`;

  const requirements: CantonPaymentRequirements = {
    scheme: "exact",
    network: NETWORK,
    amount: "100000000",
    asset: "CC",
    extra: {
      assetTransferMethod: "transfer-factory",
      executeBeforeSeconds,
      instrumentId: { id: "Amulet", admin: "DSO::1220dso" },
      ...(overrides.memo === undefined ? {} : { memo: overrides.memo }),
    },
    payTo: "merchant::1220merch",
    resource: "/api/resource",
    maxTimeoutSeconds: 60,
  };

  const preparedTransactionHash = "aa".repeat(32); // 32-byte hex message
  const partySignature = signHash(preparedTransactionHash, toB64(seed));

  // A prepared-transaction blob whose TransferFactory_Transfer matches the
  // requirements (payer → payTo, the required Amulet, the required amount).
  // The transfer carries an on-ledger Decimal; the quote is in atomic units.
  // Its deadline is the quoted horizon from now, as a real payer computes it.
  const executeBeforeMicros = BigInt(Date.now() + executeBeforeSeconds * 1000) * 1000n;
  const preparedTransaction = encodePreparedTransaction({
    sender: payer,
    receiver: requirements.payTo,
    amount: atomicToLedger(requirements.amount, 10) as string, // Canton Coin
    instrumentId: requirements.extra.instrumentId,
    executeBeforeMicros,
    ...(overrides.memo === undefined ? {} : { memo: overrides.memo }),
  });

  const payload: CantonPaymentPayload = {
    x402Version: 2,
    scheme: "exact",
    network: NETWORK,
    payload: {
      payer,
      preparedTransaction,
      preparedTransactionHash,
      partySignature,
      requirementsHash: requirementsHash(requirements),
      publicKey: pubB64,
      hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
    },
  };

  return { requirements, payload, payer, executeBeforeMicros };
}

/**
 * The same payload with the transfer re-encoded at a different deadline. Only
 * the blob changes: the signature is over `preparedTxHash`, and the hash is
 * over the requirements, so neither depends on the transfer's bytes — which is
 * what lets this vary one field and leave every earlier check passing.
 */
function reDeadline(
  payload: CantonPaymentPayload,
  requirements: CantonPaymentRequirements,
  executeBeforeMicros: bigint | undefined,
): CantonPaymentPayload {
  const preparedTransaction = encodePreparedTransaction({
    sender: payload.payload.payer,
    receiver: requirements.payTo,
    amount: atomicToLedger(requirements.amount, 10) as string,
    instrumentId: requirements.extra.instrumentId,
    ...(executeBeforeMicros === undefined ? {} : { executeBeforeMicros }),
  });
  return { ...payload, payload: { ...payload.payload, preparedTransaction } };
}

describe("cantonExactVerifier", () => {
  const verifier = createCantonExactVerifier(NETWORK);

  it("has the expected identity", () => {
    expect(verifier.schemeId).toBe("exact");
    expect(verifier.networkId).toBe(NETWORK);
  });

  it("accepts a well-formed, correctly-signed payload", () => {
    const { payload, requirements, payer } = buildSignedFixture();
    const result = verifier.verify(payload, requirements);
    expect(result).toEqual({ isValid: true, payer });
  });

  it("rejects a scheme mismatch", () => {
    const { payload, requirements } = buildSignedFixture();
    const result = verifier.verify({ ...payload, scheme: "batch-settlement-canton" }, {
      ...requirements,
      scheme: "batch-settlement-canton",
    });
    expect(result).toEqual({ isValid: false, invalidReason: "scheme_mismatch" });
  });

  it("rejects a network the verifier is not bound to", () => {
    const { payload, requirements } = buildSignedFixture();
    const other = "canton:mainnet";
    const result = verifier.verify({ ...payload, network: other }, { ...requirements, network: other });
    expect(result).toMatchObject({ isValid: false, invalidReason: "network_mismatch" });
  });

  it("rejects a requirementsHash that doesn't bind to the requirements", () => {
    const { payload, requirements } = buildSignedFixture();
    const p = { ...payload, payload: { ...payload.payload, requirementsHash: "deadbeef" } };
    expect(verifier.verify(p, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "requirements_hash_mismatch",
    });
  });

  it("rejects a payer whose fingerprint doesn't match the public key", () => {
    const { payload, requirements } = buildSignedFixture();
    const p = { ...payload, payload: { ...payload.payload, payer: "mallory::1220wrong" } };
    // rebind the hash so we fail on fingerprint, not on the hash check
    const req = requirements;
    expect(verifier.verify(p, req)).toMatchObject({
      isValid: false,
      invalidReason: "bad_fingerprint",
    });
  });

  it("rejects a bad signature", () => {
    const { payload, requirements } = buildSignedFixture();
    const p = { ...payload, payload: { ...payload.payload, partySignature: "ff".repeat(64) } };
    expect(verifier.verify(p, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "bad_signature",
    });
  });

  it("rejects a prepared transaction whose transfer node is also encoded as another node type", () => {
    // Correctly signed and the transfer matches, but protobuf keeps the last
    // member of a oneof, so Canton would read this node as a create.
    const { payload, requirements, payer } = buildSignedFixture();
    const preparedTransaction = encodePreparedTransaction(
      {
        sender: payer,
        receiver: requirements.payTo,
        amount: atomicToLedger(requirements.amount, 10) as string, // Canton Coin
        instrumentId: requirements.extra.instrumentId,
      },
      { extra: { node: wrap(1, new Uint8Array()) } },
    );
    const p = { ...payload, payload: { ...payload.payload, preparedTransaction } };
    expect(verifier.verify(p, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "transfer_mismatch",
      extensions: { detail: "undecodable" },
    });
  });

  it("rejects a prepared transaction that lists a second node under the transfer node's id", () => {
    // Canton keeps the last node of a repeated id, so it would run the create.
    const { payload, requirements, payer } = buildSignedFixture();
    const preparedTransaction = encodePreparedTransaction(
      {
        sender: payer,
        receiver: requirements.payTo,
        amount: atomicToLedger(requirements.amount, 10) as string, // Canton Coin
        instrumentId: requirements.extra.instrumentId,
      },
      { nodes: [encodeNode("0", wrap(1, new Uint8Array()))] },
    );
    const p = { ...payload, payload: { ...payload.payload, preparedTransaction } };
    expect(verifier.verify(p, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "transfer_mismatch",
      extensions: { detail: "undecodable" },
    });
  });

  it("refuses a transfer whose deadline has passed, or is about to (Rule 10)", () => {
    // The margin exists because settling is not instantaneous: accepting at
    // T-1ms guarantees the wasted relay it is meant to avoid.
    const { payload, requirements } = buildSignedFixture();
    const nowMicros = BigInt(Date.now()) * 1000n;
    for (const executeBeforeMicros of [nowMicros - 60_000_000n, nowMicros, nowMicros + 1_000_000n]) {
      const p = reDeadline(payload, requirements, executeBeforeMicros);
      expect(verifier.verify(p, requirements)).toMatchObject({
        isValid: false,
        invalidReason: "transfer_expired",
      });
    }
  });

  it("refuses a transfer that carries no deadline at all", () => {
    // Not "no deadline, therefore fine": a real transfer always has one, and
    // reading an absent field as unlimited would make Rule 10 skippable by
    // leaving it out.
    const { payload, requirements } = buildSignedFixture();
    const p = reDeadline(payload, requirements, undefined);
    expect(verifier.verify(p, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "transfer_expired",
    });
  });

  it("binds the memo when the merchant quotes one (Rule 12)", () => {
    const quoted = buildSignedFixture({ memo: "invoice-2024-001" });
    expect(verifier.verify(quoted.payload, quoted.requirements)).toMatchObject({ isValid: true });

    // Signed a different memo, or none, against requirements that quote one.
    for (const memo of ["invoice-2024-002", undefined]) {
      const other = buildSignedFixture(memo === undefined ? {} : { memo });
      const p = { ...other.payload, payload: { ...other.payload.payload } };
      expect(
        verifier.verify({ ...p, payload: { ...p.payload, requirementsHash: quoted.payload.payload.requirementsHash } }, quoted.requirements),
      ).toMatchObject({ invalidReason: "transfer_mismatch", extensions: { detail: "memo" } });
    }
  });

  it("ignores a memo the merchant did not quote", () => {
    // An unquoted memo is the payer's own reference. Refusing it would reject a
    // payment that satisfies every term the merchant actually set.
    const { requirements } = buildSignedFixture();
    const withMemo = buildSignedFixture({ memo: "payer's own note" });
    const p = {
      ...withMemo.payload,
      payload: { ...withMemo.payload.payload, requirementsHash: requirementsHash(requirements) },
    };
    expect(verifier.verify(p, requirements)).toMatchObject({ isValid: true });
  });

  it("reports missing_public_key for a blank OR absent key (specific reason, not internal_error)", () => {
    const { payload, requirements } = buildSignedFixture();
    // blank string
    const blank = { ...payload, payload: { ...payload.payload, publicKey: "" } };
    expect(verifier.verify(blank, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "missing_public_key",
    });
    // entirely absent — the specific reason must survive the completed inner guard
    const { publicKey: _omit, ...innerNoKey } = payload.payload;
    const absent = { ...payload, payload: innerNoKey };
    expect(verifier.verify(absent, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "missing_public_key",
    });
  });

  it("rejects a payload missing hashingSchemeVersion (internal_error)", () => {
    const { payload, requirements } = buildSignedFixture();
    const { hashingSchemeVersion: _omit, ...innerNoScheme } = payload.payload;
    const p = { ...payload, payload: innerNoScheme };
    expect(verifier.verify(p, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "internal_error",
    });
  });
});

describe("createVerifierRegistry", () => {
  const verifier = createCantonExactVerifier(NETWORK);
  const registry = createVerifierRegistry([verifier]);

  it("finds a registered verifier by (scheme, network)", () => {
    expect(registry.find("exact", NETWORK)).toBe(verifier);
    expect(registry.find("exact", "canton:mainnet")).toBeUndefined();
    expect(registry.find("unknown-scheme", NETWORK)).toBeUndefined();
  });

  it("dispatches a payload to its verifier", () => {
    const { payload, requirements, payer } = buildSignedFixture();
    expect(registry.verify(payload, requirements)).toEqual({ isValid: true, payer });
  });

  it("returns scheme_mismatch for an unregistered (scheme, network)", () => {
    const { payload, requirements } = buildSignedFixture();
    const p = { ...payload, network: "canton:testnet" };
    expect(registry.verify(p, requirements)).toEqual({
      isValid: false,
      invalidReason: "scheme_mismatch",
    });
  });

  it("adding a scheme = registering another SchemeVerifier (no dispatcher change)", () => {
    // A second, non-Canton verifier slots into the same registry with no casts —
    // it just implements the SchemeVerifier contract over the widest envelope.
    const evmVerifier: SchemeVerifier = {
      schemeId: "exact-evm-to-canton-cc",
      networkId: "eip155:1",
      verify: () => ({ isValid: true, payer: "0xpayer" }),
    };
    const multi = createVerifierRegistry([verifier, evmVerifier]);
    const { payload, requirements, payer } = buildSignedFixture();

    expect(multi.verify(payload, requirements)).toEqual({ isValid: true, payer });
    const evmPayload = { x402Version: 2 as const, scheme: "exact-evm-to-canton-cc", network: "eip155:1", payload: {} };
    const evmReq = { ...requirements, scheme: "exact-evm-to-canton-cc", network: "eip155:1" };
    expect(multi.verify(evmPayload, evmReq)).toEqual({ isValid: true, payer: "0xpayer" });
  });
});

describe("the ids the verifier answers to", () => {
  /**
   * The fixture re-pointed at another scheme/network. `requirementsHash` walks
   * the whole requirements object, so changing either re-derives it — a payload
   * paying `exact` must be bound to requirements that say `exact`.
   */
  function fixtureFor(scheme: string, network: string) {
    const { payload, requirements, payer } = buildSignedFixture();
    const req = { ...requirements, scheme, network };
    return {
      payer,
      requirements: req,
      payload: {
        ...payload,
        scheme,
        network,
        payload: { ...payload.payload, requirementsHash: requirementsHash(req) },
      },
    };
  }

  const verifies = (v: SchemeVerifier, scheme: string, network = NETWORK) => {
    const f = fixtureFor(scheme, network);
    return v.verify(f.payload, f.requirements);
  };

  const verifier = createCantonExactVerifier(NETWORK);

  it("advertises the id the registered spec defines", () => {
    expect(verifier.schemeId).toBe(EXACT_SCHEME_ID);
    expect(verifier.schemeId).toBe("exact");
    expect(verifier.networkId).toBe(NETWORK);
  });

  it("accepts the spec's id", () => {
    expect(verifies(verifier, EXACT_SCHEME_ID)).toMatchObject({ isValid: true });
  });

  it("refuses the retired `exact-canton` id", () => {
    expect(verifies(verifier, "exact-canton")).toEqual({
      isValid: false,
      invalidReason: "scheme_mismatch",
    });
  });

  it("refuses an unrelated scheme id", () => {
    expect(verifies(verifier, "exact-evm-to-canton-cc")).toEqual({
      isValid: false,
      invalidReason: "scheme_mismatch",
    });
  });

  it("refuses a payload and requirements that disagree about the scheme", () => {
    // Both sides are checked, so naming the right id on one is not enough.
    const { payload, requirements } = fixtureFor(EXACT_SCHEME_ID, NETWORK);
    expect(
      verifier.verify({ ...payload, scheme: "exact-canton" }, requirements),
    ).toEqual({ isValid: false, invalidReason: "scheme_mismatch" });
  });

  it("refuses requirements naming another scheme, even when the payload is right", () => {
    // Needs its own case: with only the payload side checked this reaches the
    // hash check and reports requirements_hash_mismatch instead.
    const { payload, requirements } = fixtureFor(EXACT_SCHEME_ID, NETWORK);
    expect(
      verifier.verify(payload, { ...requirements, scheme: "exact-canton" }),
    ).toEqual({ isValid: false, invalidReason: "scheme_mismatch" });
  });

  it("refuses requirements naming another network, even when the payload is right", () => {
    const { payload, requirements } = fixtureFor(EXACT_SCHEME_ID, NETWORK);
    expect(
      verifier.verify(payload, { ...requirements, network: MAINNET_NETWORK }),
    ).toEqual({ isValid: false, invalidReason: "network_mismatch" });
  });

  it("refuses a network other than the one it is bound to", () => {
    expect(verifies(verifier, EXACT_SCHEME_ID, MAINNET_NETWORK)).toEqual({
      isValid: false,
      invalidReason: "network_mismatch",
    });
  });

  it("refuses a payload and requirements that disagree about the network", () => {
    const { payload, requirements } = fixtureFor(EXACT_SCHEME_ID, NETWORK);
    expect(
      verifier.verify({ ...payload, network: MAINNET_NETWORK }, requirements),
    ).toEqual({ isValid: false, invalidReason: "network_mismatch" });
  });
});
