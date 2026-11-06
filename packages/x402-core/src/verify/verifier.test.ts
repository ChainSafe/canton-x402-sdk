import { describe, it, expect } from "vitest";
import { getPublicKey, hashes } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  atomicToLedger,
  createCantonExactVerifier,
  createVerifierRegistry,
  decodePreparedTransaction,
  EXACT_SCHEME_ID,
  fingerprintForPublicKey,
  gzipPreparedTransaction,
  signatureToBase64,
  signHash,
} from "./index";
import { requirementsHash as requirementsHashOf } from "../hashing";
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

/** A protobuf blob in the gzipped base64 form the payload carries it in. */
const gzipped = (protobufB64: string): string =>
  gzipPreparedTransaction(Buffer.from(protobufB64, "base64"));

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
      synchronizerId: "global-domain::1220sync",
      executeBeforeSeconds,
      instrumentId: { id: "Amulet", admin: "DSO::1220dso" },
      ...(overrides.memo === undefined ? {} : { memo: overrides.memo }),
    },
    payTo: "merchant::1220merch",
    resource: "/api/resource",
    maxTimeoutSeconds: 60,
  };

  const preparedTxHash = "aa".repeat(32); // 32-byte hex message
  const signatureHex = signHash(preparedTxHash, toB64(seed));

  // A prepared-transaction blob whose TransferFactory_Transfer matches the
  // requirements (payer → payTo, the required Amulet, the required amount),
  // gzipped as the payload carries it. The transfer carries an on-ledger
  // Decimal; the quote is in atomic units.
  // Its deadline is the quoted horizon from now, as a real payer computes it.
  const executeBeforeMicros = BigInt(Date.now() + executeBeforeSeconds * 1000) * 1000n;
  const protobuf = encodePreparedTransaction({
    sender: payer,
    receiver: requirements.payTo,
    amount: atomicToLedger(requirements.amount, 10) as string, // Canton Coin
    instrumentId: requirements.extra.instrumentId,
    executeBeforeMicros,
    // The physical form, as a participant signs it.
    synchronizerId: `${requirements.extra.synchronizerId}::35-2`,
    ...(overrides.memo === undefined ? {} : { memo: overrides.memo }),
  });
  const preparedTransaction = gzipped(protobuf);

  const payload: CantonPaymentPayload = {
    x402Version: 2,
    scheme: "exact",
    network: NETWORK,
    payload: {
      assetTransferMethod: "transfer-factory",
      payer,
      preparedTransaction,
      preparedTxHash,
      signature: signatureToBase64(signatureHex),
      publicKey: pubB64,
      hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
    },
  };

  return { requirements, payload, payer, signatureHex, seedB64: toB64(seed), protobuf, executeBeforeMicros };
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * The same 64 bytes with a padding bit set. A 64-byte signature ends in one
 * data character and "=="; that character's low four bits are padding, so
 * flipping the lowest still decodes to the same bytes but is not canonical.
 */
function withPaddingBitSet(signature: string): string {
  const i = signature.length - 3;
  const flipped = BASE64_ALPHABET[BASE64_ALPHABET.indexOf(signature[i]) ^ 1];
  return signature.slice(0, i) + flipped + signature.slice(i + 1);
}

/**
 * The same payload with the transfer re-encoded at a different deadline. Only
 * the blob changes: the signature is over `preparedTxHash`, which does not
 * depend on the transfer's bytes — which is what lets this vary one field and
 * leave every earlier check passing.
 */
function reDeadline(
  payload: CantonPaymentPayload,
  requirements: CantonPaymentRequirements,
  executeBeforeMicros: bigint | undefined,
): CantonPaymentPayload {
  const preparedTransaction = gzipped(
    encodePreparedTransaction({
      sender: payload.payload.payer,
      receiver: requirements.payTo,
      amount: atomicToLedger(requirements.amount, 10) as string,
      instrumentId: requirements.extra.instrumentId,
      synchronizerId: `${requirements.extra.synchronizerId}::35-2`,
      ...(executeBeforeMicros === undefined ? {} : { executeBeforeMicros }),
    }),
  );
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

  it("ignores a requirementsHash an older payer still sends, right or wrong", () => {
    // The spec has no such field, and an unsigned hash binds nothing the decoded
    // transfer does not: it is not checked, so a stale one does not fail the payment.
    const { payload, requirements, payer } = buildSignedFixture();
    for (const requirementsHash of [requirementsHashOf(requirements), "deadbeef"]) {
      const p = { ...payload, payload: { ...payload.payload, requirementsHash } };
      expect(verifier.verify(p, requirements)).toEqual({ isValid: true, payer });
    }
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
    const p = {
      ...payload,
      payload: { ...payload.payload, signature: signatureToBase64("ff".repeat(64)) },
    };
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
    const p = { ...payload, payload: { ...payload.payload, preparedTransaction: gzipped(preparedTransaction) } };
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
    const p = { ...payload, payload: { ...payload.payload, preparedTransaction: gzipped(preparedTransaction) } };
    expect(verifier.verify(p, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "transfer_mismatch",
      extensions: { detail: "undecodable" },
    });
  });

  it("reads the signature only as canonical base64 of 64 bytes", () => {
    const { payload, requirements, signatureHex } = buildSignedFixture();
    const signature = payload.payload.signature;
    const nonCanonical = withPaddingBitSet(signature);
    // Decodes to the very same signature, so only the canonical check refuses it.
    expect(atob(nonCanonical)).toBe(atob(signature));
    const urlSafe = signature.replace(/\+/g, "-").replace(/\//g, "_");
    // The fixture's signature is fixed, and it has a "+" or a "/" to replace.
    expect(urlSafe).not.toBe(signature);
    // Hex is what a payer built against the old field sends. Its 128 digits are
    // valid base64 too, so the 64-byte check is what refuses it.
    for (const variant of [signatureHex, signature.replace(/=+$/, ""), nonCanonical, urlSafe, ` ${signature}`]) {
      const p = { ...payload, payload: { ...payload.payload, signature: variant } };
      expect(verifier.verify(p, requirements)).toMatchObject({
        isValid: false,
        invalidReason: "bad_signature",
      });
    }
  });

  it("answers bad_signature for a signature of megabytes, rather than throwing", () => {
    // Unbounded, the base64 regex runs out of backtracking stack at about 4.5M
    // characters and throws.
    const { payload, requirements } = buildSignedFixture();
    const p = { ...payload, payload: { ...payload.payload, signature: "A".repeat(5 * 1024 * 1024) } };
    expect(verifier.verify(p, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "bad_signature",
    });
  });

  it("reads preparedTxHash only as 64 lower-case hex digits", () => {
    const { payload, requirements, seedB64 } = buildSignedFixture();
    const hash = payload.payload.preparedTxHash;
    // Each variant carries a valid signature over its own bytes, so the
    // encoding check is the only thing that can refuse it. Upper case is the
    // same 32 bytes that were signed.
    for (const preparedTxHash of [hash.toUpperCase(), `1220${hash}`, `${hash}00`, hash.slice(2)]) {
      const signature = signatureToBase64(signHash(preparedTxHash, seedB64));
      const p = { ...payload, payload: { ...payload.payload, preparedTxHash, signature } };
      expect(verifier.verify(p, requirements)).toMatchObject({
        isValid: false,
        invalidReason: "bad_signature",
      });
    }
  });

  it("refuses an empty hash or signature at the shape check", () => {
    const { payload, requirements } = buildSignedFixture();
    for (const field of ["preparedTxHash", "signature"] as const) {
      const p = { ...payload, payload: { ...payload.payload, [field]: "" } };
      expect(verifier.verify(p, requirements)).toMatchObject({
        isValid: false,
        invalidReason: "internal_error",
      });
    }
  });

  it("reads preparedTransaction only as one gzip member within the caps", () => {
    const { payload, requirements, protobuf } = buildSignedFixture();
    const bytes = Buffer.from(protobuf, "base64");
    // The same transfer padded past the 64 KiB decompressed cap with an unknown
    // field (15, length-delimited), which the decoder skips. It decodes to the
    // matching transfer, so only the cap can refuse it; about 100 bytes gzipped.
    const pad = 70_000;
    const padded = Buffer.concat([bytes, Buffer.from([(15 << 3) | 2, 0x80 | (pad & 0x7f), 0x80 | ((pad >> 7) & 0x7f), pad >> 14]), Buffer.alloc(pad)]);
    expect(decodePreparedTransaction(padded.toString("base64"))).not.toBeNull();
    const overCap = gzipPreparedTransaction(padded);
    // One gzip member and then a byte: refused by the single-member rule.
    const trailing = Buffer.concat([Buffer.from(payload.payload.preparedTransaction, "base64"), Buffer.from([0])]).toString("base64");
    // The protobuf without gzip is what a payer built before this sends.
    for (const preparedTransaction of [protobuf, overCap, trailing]) {
      const p = { ...payload, payload: { ...payload.payload, preparedTransaction } };
      expect(verifier.verify(p, requirements)).toEqual({
        isValid: false,
        invalidReason: "transfer_mismatch",
        payer: payload.payload.payer,
        extensions: { detail: "undecodable" },
      });
    }
  });

  it("refuses a payload without assetTransferMethod, or with another value, at the shape check", () => {
    // Everything else is right: the signature verifies and the transfer matches.
    const { payload, requirements } = buildSignedFixture();
    const { assetTransferMethod: _omit, ...withoutMethod } = payload.payload;
    const variants = [withoutMethod, { ...payload.payload, assetTransferMethod: "transfer-preapproval" }];
    for (const inner of variants) {
      const p = { ...payload, payload: inner } as unknown as CantonPaymentPayload;
      expect(verifier.verify(p, requirements)).toEqual({ isValid: false, invalidReason: "internal_error" });
    }
  });

  it("does not read the pre-spec field names", () => {
    const { payload, requirements } = buildSignedFixture();
    const { preparedTxHash, signature, ...rest } = payload.payload;
    const p = {
      ...payload,
      payload: { ...rest, preparedTransactionHash: preparedTxHash, partySignature: signature },
    };
    expect(verifier.verify(p, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "internal_error",
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
      expect(verifier.verify(other.payload, quoted.requirements)).toMatchObject({
        invalidReason: "transfer_mismatch",
        extensions: { detail: "memo" },
      });
    }
  });

  it("refuses a memo the merchant did not quote", () => {
    // `x402.memo` is the scheme's key, not the payer's. Letting a payer name an
    // order the merchant never quoted lets a cheap payment reconcile against an
    // expensive one, for any merchant that matches ledger payments by memo.
    const { requirements } = buildSignedFixture();
    const withMemo = buildSignedFixture({ memo: "someone else's order" });
    expect(verifier.verify(withMemo.payload, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "transfer_mismatch",
      extensions: { detail: "memo" },
    });
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

  it("accepts a payload without hashingSchemeVersion, which the spec reads as V2", () => {
    const { payload, requirements, payer } = buildSignedFixture();
    const { hashingSchemeVersion: _omit, ...innerNoScheme } = payload.payload;
    const p = { ...payload, payload: innerNoScheme };
    expect(verifier.verify(p, requirements)).toEqual({ isValid: true, payer });
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
   * The fixture re-pointed at another scheme/network, on both the payload and the
   * requirements, so only the id under test differs from a valid payment.
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
    // Needs its own case: nothing after the scheme check reads the requirements'
    // scheme (the transfer does not carry it), so checking only the payload side
    // would let this verify.
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
