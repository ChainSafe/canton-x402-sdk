import { describe, it, expect } from "vitest";
import { getPublicKey, hashes } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  atomicToLedger,
  computePreparedTransactionHash,
  createCantonExactVerifier,
  createVerifierRegistry,
  decodePayloadTransfer,
  decodePreparedTransaction,
  EXACT_SCHEME_ID,
  fingerprintForPublicKey,
  gzipPreparedTransaction,
  signatureToBase64,
  signHash,
} from "./index";
import { requirementsHash as requirementsHashOf } from "../hashing";
import { HashingSchemeVersion } from "../types/payment";
import {
  encodeNode,
  encodePreparedTransaction,
  encodePreparedTransactionGraph,
  wrap,
} from "./prepared-tx.fixtures";
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
async function buildSignedFixture(overrides: { executeBeforeSeconds?: number; memo?: string } = {}) {
  const executeBeforeSeconds = overrides.executeBeforeSeconds ?? 120;
  const seed = new Uint8Array(32).fill(3);
  const privateKey = toB64(seed);
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
    ...(overrides.memo === undefined ? {} : { memo: overrides.memo }),
  });
  const preparedTransaction = gzipped(protobuf);
  const preparedTxHash = await computePreparedTransactionHash(
    protobuf,
    HashingSchemeVersion.V2,
  );
  const signatureHex = signHash(preparedTxHash, privateKey);

  const payload: CantonPaymentPayload = {
    x402Version: 2,
    scheme: "exact",
    network: NETWORK,
    payload: {
      assetTransferMethod: "transfer-factory",
      preparedTransaction,
      preparedTxHash,
      signature: signatureToBase64(signatureHex),
      publicKey: pubB64,
      hashingSchemeVersion: HashingSchemeVersion.V2,
    },
  };

  return {
    requirements,
    payload,
    payer,
    privateKey,
    signatureHex,
    executeBeforeMicros,
    seedB64: toB64(seed),
    protobuf,
  };
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
 * The same payment with the transfer re-encoded at a different deadline.
 * Rehashed and re-signed, because the signature is bound to the transaction
 * now — without that these would fail at the hash check and never reach
 * Rule 10, passing for the wrong reason.
 */
async function reDeadline(
  fixture: Awaited<ReturnType<typeof buildSignedFixture>>,
  executeBeforeMicros: bigint | undefined,
): Promise<CantonPaymentPayload> {
  const { payload, requirements, payer, privateKey } = fixture;
  const protobuf = encodePreparedTransaction({
    sender: payer,
    receiver: requirements.payTo,
    amount: atomicToLedger(requirements.amount, 10) as string,
    instrumentId: requirements.extra.instrumentId,
    ...(executeBeforeMicros === undefined ? {} : { executeBeforeMicros }),
  });
  const preparedTxHash = await computePreparedTransactionHash(protobuf, HashingSchemeVersion.V2);
  return {
    ...payload,
    payload: {
      ...payload.payload,
      preparedTransaction: gzipped(protobuf),
      preparedTxHash,
      signature: signatureToBase64(signHash(preparedTxHash, privateKey)),
    },
  };
}

describe("cantonExactVerifier", () => {
  const verifier = createCantonExactVerifier(NETWORK);

  it("has the expected identity", () => {
    expect(verifier.schemeId).toBe("exact");
    expect(verifier.networkId).toBe(NETWORK);
  });

  it("accepts a well-formed, correctly-signed payload", async () => {
    const { payload, requirements, payer } = await buildSignedFixture();
    const result = await verifier.verify(payload, requirements);
    expect(result).toEqual({ isValid: true, payer });
  });

  it("rejects a hash that is not bound to the prepared transaction", async () => {
    const { payload, requirements, privateKey } = await buildSignedFixture();
    const unrelatedHash = "aa".repeat(32);
    const maliciousPayload = {
      ...payload,
      payload: {
        ...payload.payload,
        preparedTxHash: unrelatedHash,
        signature: signatureToBase64(signHash(unrelatedHash, privateKey)),
      },
    };

    const result = await verifier.verify(maliciousPayload, requirements);

    expect(result).toMatchObject({
      isValid: false,
      invalidReason: "prepared_transaction_hash_mismatch",
    });
  });

  it("rejects an unsafe transaction graph before canonical hashing", async () => {
    const { payload, requirements } = await buildSignedFixture();
    const cyclicTransaction = encodePreparedTransactionGraph(["0"], [{ id: "0", children: ["0"] }]);
    const maliciousPayload = {
      ...payload,
      payload: {
        ...payload.payload,
        preparedTransaction: gzipped(cyclicTransaction),
      },
    };

    expect(await verifier.verify(maliciousPayload, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "invalid_prepared_transaction_structure",
      extensions: { detail: "duplicate_reference" },
    });
  });

  it("rejects a scheme mismatch", async () => {
    const { payload, requirements } = await buildSignedFixture();
    const result = await verifier.verify(
      { ...payload, scheme: "batch-settlement-canton" },
      {
        ...requirements,
        scheme: "batch-settlement-canton",
      },
    );
    expect(result).toEqual({ isValid: false, invalidReason: "scheme_mismatch" });
  });

  it("rejects a network the verifier is not bound to", async () => {
    const { payload, requirements } = await buildSignedFixture();
    const other = MAINNET_NETWORK;
    const result = await verifier.verify(
      { ...payload, network: other },
      { ...requirements, network: other },
    );
    expect(result).toMatchObject({ isValid: false, invalidReason: "network_mismatch" });
  });

  it("ignores a requirementsHash an older payer still sends, right or wrong", async () => {
    // The spec has no such field, and an unsigned hash binds nothing the decoded
    // transfer does not: it is not checked, so a stale one does not fail the payment.
    const { payload, requirements, payer } = await buildSignedFixture();
    for (const requirementsHash of [requirementsHashOf(requirements), "deadbeef"]) {
      const p = { ...payload, payload: { ...payload.payload, requirementsHash } };
      expect(await verifier.verify(p, requirements)).toEqual({ isValid: true, payer });
    }
  });

  it("reports the transfer's sender as the payer, whatever payer an older payload names", async () => {
    // The spec's payload names no payer (Rule 8). A `payer` an older payer still
    // sends is ignored, so it can neither fail the payment nor change who it
    // reports as having paid.
    const { payload, requirements, payer } = await buildSignedFixture();
    const p = { ...payload, payload: { ...payload.payload, payer: "mallory::1220wrong" } };
    expect(await verifier.verify(p, requirements)).toEqual({ isValid: true, payer });
  });

  it("refuses a key that is not the sender's: a transfer from another party, signed with this key", async () => {
    // The fingerprint check is what binds the key to the transfer's sender.
    // Without it, any key could sign a transfer naming someone else. The hash
    // and signature are right for this transaction, so only that check refuses.
    const { payload, requirements, privateKey } = await buildSignedFixture();
    const victim = `victim::${fingerprintForPublicKey(toB64(getPublicKey(new Uint8Array(32).fill(9))))}`;
    const protobuf = encodePreparedTransaction({
      sender: victim,
      receiver: requirements.payTo,
      amount: atomicToLedger(requirements.amount, 10) as string, // Canton Coin
      instrumentId: requirements.extra.instrumentId,
    });
    const preparedTxHash = await computePreparedTransactionHash(protobuf, HashingSchemeVersion.V2);
    const p = {
      ...payload,
      payload: {
        ...payload.payload,
        preparedTransaction: gzipped(protobuf),
        preparedTxHash,
        signature: signatureToBase64(signHash(preparedTxHash, privateKey)),
      },
    };
    expect(await verifier.verify(p, requirements)).toEqual({ isValid: false, invalidReason: "bad_fingerprint", payer: victim });
  });

  it("rejects a bad signature", async () => {
    const { payload, requirements, payer } = await buildSignedFixture();
    const p = {
      ...payload,
      payload: {
        ...payload.payload,
        signature: signatureToBase64("ff".repeat(64)),
      },
    };
    expect(await verifier.verify(p, requirements)).toEqual({ isValid: false, invalidReason: "bad_signature", payer });
  });

  it("refuses a transfer that pays another party or another amount, naming its sender as the payer", async () => {
    // The binding runs on the decoded transfer, and the payer it reports is that
    // transfer's sender: the payload names none.
    const { payload, requirements, payer } = await buildSignedFixture();
    const cases = [
      [{ ...requirements, payTo: "someoneelse::1220" }, "receiver"],
      [{ ...requirements, amount: "100000001" }, "amount"],
      [{ ...requirements, extra: { ...requirements.extra, instrumentId: { id: "USDC", admin: "DSO::1220dso" } } }, "instrument"],
    ] as const;
    for (const [req, detail] of cases) {
      expect(await verifier.verify(payload, req)).toEqual({
        isValid: false,
        invalidReason: "transfer_mismatch",
        payer,
        extensions: { detail },
      });
    }
  });

  it("decodes a payload's preparedTransaction to the transfer, and anything else to null", async () => {
    const { payload, payer, requirements } = await buildSignedFixture();
    expect(decodePayloadTransfer(payload.payload.preparedTransaction)).toMatchObject({
      sender: payer,
      receiver: requirements.payTo,
    });
    // Untrusted input: no throw for a value that is not a string.
    for (const junk of ["", "not base64!", 123, undefined, null, {}]) {
      expect(decodePayloadTransfer(junk as unknown as string)).toBeNull();
    }
  });

  it("rejects a prepared transaction whose transfer node is also encoded as another node type", async () => {
    // Correctly signed and the transfer matches, but protobuf keeps the last
    // member of a oneof, so Canton would read this node as a create.
    const { payload, requirements, payer } = await buildSignedFixture();
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
    expect(await verifier.verify(p, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "transfer_mismatch",
      extensions: { detail: "undecodable" },
    });
  });

  it("rejects a prepared transaction that lists a second node under the transfer node's id", async () => {
    // Canton keeps the last node of a repeated id, so it would run the create.
    const { payload, requirements, payer } = await buildSignedFixture();
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
    expect(await verifier.verify(p, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "invalid_prepared_transaction_structure",
      extensions: { detail: "duplicate_node_id" },
    });
  });

  it("reads the signature only as canonical base64 of 64 bytes", async () => {
    const { payload, requirements, signatureHex, payer } = await buildSignedFixture();
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
      expect(await verifier.verify(p, requirements)).toEqual({
        isValid: false,
        invalidReason: "bad_signature",
        payer,
      });
    }
  });

  it("answers bad_signature for a signature of megabytes, rather than throwing", async () => {
    // Unbounded, the base64 regex runs out of backtracking stack at about 4.5M
    // characters and throws.
    const { payload, requirements } = await buildSignedFixture();
    const p = { ...payload, payload: { ...payload.payload, signature: "A".repeat(5 * 1024 * 1024) } };
    expect(await verifier.verify(p, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "bad_signature",
    });
  });

  it("reads preparedTxHash only as 64 lower-case hex digits", async () => {
    const { payload, requirements, seedB64 } = await buildSignedFixture();
    const hash = payload.payload.preparedTxHash;
    // Each variant carries a valid signature over its own bytes, so the
    // encoding check is the only thing that can refuse it. Upper case is the
    // same 32 bytes that were signed.
    for (const preparedTxHash of [hash.toUpperCase(), `1220${hash}`, `${hash}00`, hash.slice(2)]) {
      const signature = signatureToBase64(signHash(preparedTxHash, seedB64));
      const p = { ...payload, payload: { ...payload.payload, preparedTxHash, signature } };
      expect(await verifier.verify(p, requirements)).toMatchObject({
        isValid: false,
        invalidReason: "bad_signature",
      });
    }
  });

  it("refuses an empty hash or signature at the shape check", async () => {
    const { payload, requirements } = await buildSignedFixture();
    for (const field of ["preparedTxHash", "signature"] as const) {
      const p = { ...payload, payload: { ...payload.payload, [field]: "" } };
      expect(await verifier.verify(p, requirements)).toMatchObject({
        isValid: false,
        invalidReason: "internal_error",
      });
    }
  });

  it("reads preparedTransaction only as one gzip member within the caps", async () => {
    const { payload, requirements, protobuf } = await buildSignedFixture();
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
      expect(await verifier.verify(p, requirements)).toEqual({
        isValid: false,
        invalidReason: "transfer_mismatch",
        extensions: { detail: "undecodable" },
      });
    }
  });

  it("refuses a payload without assetTransferMethod, or with another value, at the shape check", async () => {
    // Everything else is right: the signature verifies and the transfer matches.
    const { payload, requirements } = await buildSignedFixture();
    const { assetTransferMethod: _omit, ...withoutMethod } = payload.payload;
    const variants = [withoutMethod, { ...payload.payload, assetTransferMethod: "transfer-preapproval" }];
    for (const inner of variants) {
      const p = { ...payload, payload: inner } as unknown as CantonPaymentPayload;
      expect(await verifier.verify(p, requirements)).toEqual({ isValid: false, invalidReason: "internal_error" });
    }
  });

  it("does not read the pre-spec field names", async () => {
    const { payload, requirements } = await buildSignedFixture();
    const { preparedTxHash, signature, ...rest } = payload.payload;
    const p = {
      ...payload,
      payload: { ...rest, preparedTransactionHash: preparedTxHash, partySignature: signature },
    };
    expect(await verifier.verify(p, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "internal_error",
    });
  });

  it("refuses a transfer whose deadline has passed, or is about to (Rule 10)", async () => {
    // The margin exists because settling is not instantaneous: accepting at
    // T-1ms guarantees the wasted relay it is meant to avoid.
    const fixture = await buildSignedFixture();
    const nowMicros = BigInt(Date.now()) * 1000n;
    for (const micros of [nowMicros - 60_000_000n, nowMicros, nowMicros + 1_000_000n]) {
      expect(await verifier.verify(await reDeadline(fixture, micros), fixture.requirements)).toMatchObject({
        isValid: false,
        invalidReason: "transfer_expired",
      });
    }
  });

  it("refuses a transfer that carries no deadline at all", async () => {
    // Not "no deadline, therefore fine": a real transfer always has one, and
    // reading an absent field as unlimited would make Rule 10 skippable by
    // leaving the field out.
    const fixture = await buildSignedFixture();
    expect(await verifier.verify(await reDeadline(fixture, undefined), fixture.requirements)).toMatchObject({
      isValid: false,
      invalidReason: "transfer_expired",
    });
  });

  it("binds the memo when the merchant quotes one (Rule 12)", async () => {
    const quoted = await buildSignedFixture({ memo: "invoice-2024-001" });
    expect(await verifier.verify(quoted.payload, quoted.requirements)).toMatchObject({ isValid: true });

    // Signed a different memo, or none, against requirements that quote one.
    for (const memo of ["invoice-2024-002", undefined]) {
      const other = await buildSignedFixture(memo === undefined ? {} : { memo });
      expect(await verifier.verify(other.payload, quoted.requirements)).toMatchObject({
        invalidReason: "transfer_mismatch",
        extensions: { detail: "memo" },
      });
    }
  });

  it("refuses a memo the merchant did not quote", async () => {
    // `x402.memo` is the scheme's key, not the payer's. Letting a payer name an
    // order the merchant never quoted lets a cheap payment reconcile against an
    // expensive one, for any merchant that matches ledger payments by memo.
    const { requirements } = await buildSignedFixture();
    const withMemo = await buildSignedFixture({ memo: "someone else's order" });
    expect(await verifier.verify(withMemo.payload, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "transfer_mismatch",
      extensions: { detail: "memo" },
    });
  });

  it("reports missing_public_key for a blank OR absent key (specific reason, not internal_error)", async () => {
    // Refused before the transfer is decoded, so there is no payer to report,
    // and a stale `payer` field does not stand in for one.
    const { payload, requirements } = await buildSignedFixture();
    const stale = { ...payload.payload, payer: "mallory::1220wrong" };
    // blank string
    const blank = { ...payload, payload: { ...stale, publicKey: "" } };
    expect(await verifier.verify(blank, requirements)).toEqual({ isValid: false, invalidReason: "missing_public_key" });
    // entirely absent — the specific reason must survive the completed inner guard
    const { publicKey: _omit, ...innerNoKey } = stale;
    const absent = { ...payload, payload: innerNoKey };
    expect(await verifier.verify(absent, requirements)).toEqual({ isValid: false, invalidReason: "missing_public_key" });
  });

  it("reports missing_public_key, naming the sender, for a key that is not 32 bytes", async () => {
    const { payload, requirements, payer } = await buildSignedFixture();
    const p = { ...payload, payload: { ...payload.payload, publicKey: toB64(new Uint8Array(31)) } };
    expect(await verifier.verify(p, requirements)).toEqual({ isValid: false, invalidReason: "missing_public_key", payer });
  });

  it("accepts a payload without hashingSchemeVersion, which the spec reads as V2", async () => {
    const { payload, requirements, payer } = await buildSignedFixture();
    const { hashingSchemeVersion: _omit, ...innerNoScheme } = payload.payload;
    const p = { ...payload, payload: innerNoScheme };
    expect(await verifier.verify(p, requirements)).toEqual({ isValid: true, payer });
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

  it("dispatches a payload to its verifier", async () => {
    const { payload, requirements, payer } = await buildSignedFixture();
    expect(await registry.verify(payload, requirements)).toEqual({ isValid: true, payer });
  });

  it("returns scheme_mismatch for an unregistered (scheme, network)", async () => {
    const { payload, requirements } = await buildSignedFixture();
    const p = { ...payload, network: "canton:testnet" };
    expect(await registry.verify(p, requirements)).toEqual({
      isValid: false,
      invalidReason: "scheme_mismatch",
    });
  });

  it("adding a scheme = registering another SchemeVerifier (no dispatcher change)", async () => {
    // A second, non-Canton verifier slots into the same registry with no casts —
    // it just implements the SchemeVerifier contract over the widest envelope.
    const evmVerifier: SchemeVerifier = {
      schemeId: "exact-evm-to-canton-cc",
      networkId: "eip155:1",
      verify: () => Promise.resolve({ isValid: true, payer: "0xpayer" }),
    };
    const multi = createVerifierRegistry([verifier, evmVerifier]);
    const { payload, requirements, payer } = await buildSignedFixture();

    expect(await multi.verify(payload, requirements)).toEqual({ isValid: true, payer });
    const evmPayload = {
      x402Version: 2 as const,
      scheme: "exact-evm-to-canton-cc",
      network: "eip155:1",
      payload: {},
    };
    const evmReq = { ...requirements, scheme: "exact-evm-to-canton-cc", network: "eip155:1" };
    expect(await multi.verify(evmPayload, evmReq)).toEqual({ isValid: true, payer: "0xpayer" });
  });
});

describe("the ids the verifier answers to", () => {
  /**
   * The fixture re-pointed at another scheme/network, on both the payload and the
   * requirements, so only the id under test differs from a valid payment.
   */
  async function fixtureFor(scheme: string, network: string) {
    const { payload, requirements, payer } = await buildSignedFixture();
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

  const verifies = async (v: SchemeVerifier, scheme: string, network = NETWORK) => {
    const f = await fixtureFor(scheme, network);
    return v.verify(f.payload, f.requirements);
  };

  const verifier = createCantonExactVerifier(NETWORK);

  it("advertises the id the registered spec defines", () => {
    expect(verifier.schemeId).toBe(EXACT_SCHEME_ID);
    expect(verifier.schemeId).toBe("exact");
    expect(verifier.networkId).toBe(NETWORK);
  });

  it("accepts the spec's id", async () => {
    expect(await verifies(verifier, EXACT_SCHEME_ID)).toMatchObject({ isValid: true });
  });

  it("refuses the retired `exact-canton` id", async () => {
    expect(await verifies(verifier, "exact-canton")).toEqual({
      isValid: false,
      invalidReason: "scheme_mismatch",
    });
  });

  it("refuses an unrelated scheme id", async () => {
    expect(await verifies(verifier, "exact-evm-to-canton-cc")).toEqual({
      isValid: false,
      invalidReason: "scheme_mismatch",
    });
  });

  it("refuses a payload and requirements that disagree about the scheme", async () => {
    // Both sides are checked, so naming the right id on one is not enough.
    const { payload, requirements } = await fixtureFor(EXACT_SCHEME_ID, NETWORK);
    expect(
      await verifier.verify({ ...payload, scheme: "exact-canton" }, requirements),
    ).toEqual({ isValid: false, invalidReason: "scheme_mismatch" });
  });

  it("refuses requirements naming another scheme, even when the payload is right", async () => {
    // Needs its own case: nothing after the scheme check reads the requirements'
    // scheme (the transfer does not carry it), so checking only the payload side
    // would let this verify.
    const { payload, requirements } = await fixtureFor(EXACT_SCHEME_ID, NETWORK);
    expect(
      await verifier.verify(payload, { ...requirements, scheme: "exact-canton" }),
    ).toEqual({ isValid: false, invalidReason: "scheme_mismatch" });
  });

  it("refuses requirements naming another network, even when the payload is right", async () => {
    const { payload, requirements } = await fixtureFor(EXACT_SCHEME_ID, NETWORK);
    expect(
      await verifier.verify(payload, { ...requirements, network: MAINNET_NETWORK }),
    ).toEqual({ isValid: false, invalidReason: "network_mismatch" });
  });

  it("refuses a network other than the one it is bound to", async () => {
    expect(await verifies(verifier, EXACT_SCHEME_ID, MAINNET_NETWORK)).toEqual({
      isValid: false,
      invalidReason: "network_mismatch",
    });
  });

  it("refuses a payload and requirements that disagree about the network", async () => {
    const { payload, requirements } = await fixtureFor(EXACT_SCHEME_ID, NETWORK);
    expect(
      await verifier.verify({ ...payload, network: MAINNET_NETWORK }, requirements),
    ).toEqual({ isValid: false, invalidReason: "network_mismatch" });
  });
});
