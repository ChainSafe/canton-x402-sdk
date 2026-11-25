import { readFileSync } from "node:fs";
import { describe, it, expect, vi, afterEach } from "vitest";
import { getPublicKey, hashes } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  atomicToLedger,
  computePreparedTransactionHash,
  createCantonExactVerifier,
  createVerifierRegistry,
  decodePayloadTransfer,
  DEFAULT_MAX_DECOMPRESSED_BYTES,
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
  damlValue,
  encodeNode,
  encodePreparedTransaction,
  encodePreparedTransactionGraph,
  EXERCISED_CID,
  holdingCid,
  REGISTRY_OPERATOR,
  REGISTRY_PROVIDER,
  REGISTRY_RULE_TEMPLATE,
  stringField,
  wrap,
} from "./prepared-tx.fixtures";
import type { EncodeOptions } from "./prepared-tx.fixtures";
import type {
  CantonPaymentPayload,
  CantonPaymentRequirements,
  CantonVerifyContext,
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
/**
 * A key that is NOT the fixture's. `buildSignedFixture` seeds from a constant, so
 * two calls give the SAME party — a second fixture is not a stranger, and a test
 * that leans on one proves nothing.
 */
const OTHER_PARTY_KEY = toB64(getPublicKey(new Uint8Array(32).fill(7)));

/**
 * The success shape. `extensions.signedBy` is the fingerprint of the key that
 * verified — what a Canton submission names beside the signature. It defaults
 * to the party's `::` suffix because every fixture here signs with the key
 * that suffix names; the rotation test is the one that passes another.
 */
const verified = (payer: string, signedBy: string = payer.split("::")[1] as string) => ({
  isValid: true,
  payer,
  extensions: { signedBy },
});

async function buildSignedFixture(
  overrides: {
    executeBeforeSeconds?: number;
    memo?: string;
    /** Deform the exercised factory contract; omitted means the real shape. */
    factory?: EncodeOptions["factory"];
    /** Emit these labels blank, which puts the record in declaration order. */
    blankLabels?: EncodeOptions["blankLabels"];
    /**
     * The delivery consequence. Omitted means the real one; `null` emits none,
     * which is the transfer that would leave a pending instruction.
     */
    delivery?: EncodeOptions["delivery"] | null;
    /** A second consequence node beside the delivery. */
    second?: EncodeOptions["second"];
    /** Create nodes the transfer leaves behind. */
    creates?: EncodeOptions["creates"];
    /** The instrument quoted. Defaults to Canton Coin, which selects the preapproval arm. */
    instrumentId?: { id: string; admin: string };
    /** The amount quoted, in atomic units. Defaults to 0.01 CC. */
    amount?: string;
    /** The holdings spent. Omitted means one honest holding for the whole amount. */
    holdings?: EncodeOptions["holdings"];
    /** `inputHoldingCids` said outright, in place of the holdings' ids. */
    declaredInputs?: EncodeOptions["declaredInputs"];
    /** `inputHoldingCids` as a raw value. */
    rawInputHoldingCids?: EncodeOptions["rawInputHoldingCids"];
  } = {},
) {
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
    amount: overrides.amount ?? "100000000",
    asset: "CC",
    extra: {
      assetTransferMethod: "transfer-factory",
      synchronizerId: "global-domain::1220be58c29e",
      feePayer: "x402-facilitator::1220fee", executeBeforeSeconds,
      instrumentId: overrides.instrumentId ?? { id: "Amulet", admin: "DSO::1220dso" },
      ...(overrides.memo === undefined ? {} : { memo: overrides.memo }),
    },
    payTo: "merchant::1220merch",
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
    },
    // A real payer exercises the admin-signed factory; the check needs it.
    {
      factory: overrides.factory ?? {},
      ...(overrides.blankLabels === undefined ? {} : { blankLabels: overrides.blankLabels }),
      ...(overrides.delivery === null ? {} : { delivery: overrides.delivery ?? {} }),
      ...(overrides.second === undefined ? {} : { second: overrides.second }),
      ...(overrides.creates === undefined ? {} : { creates: overrides.creates }),
      holdings: overrides.holdings ?? [{}],
      ...(overrides.declaredInputs === undefined
        ? {}
        : { declaredInputs: overrides.declaredInputs }),
      ...(overrides.rawInputHoldingCids === undefined
        ? {}
        : { rawInputHoldingCids: overrides.rawInputHoldingCids }),
    },
  );
  const preparedTransaction = gzipped(protobuf);
  const preparedTxHash = await computePreparedTransactionHash(
    protobuf,
    HashingSchemeVersion.V2,
  );
  const signatureHex = signHash(preparedTxHash, privateKey);

  const payload: CantonPaymentPayload = {
    x402Version: 2,
    accepted: requirements,
    payload: {
      assetTransferMethod: "transfer-factory",
      preparedTransaction,
      preparedTxHash,
      signature: signatureToBase64(signatureHex),
      hashingSchemeVersion: HashingSchemeVersion.V2,
    },
  };

  return {
    requirements,
    payload,
    payer,
    // What a facilitator resolves from the payer party's own topology and
    // hands to verify. One key, which is what the party actually has.
    payerPublicKeys: [pubB64],
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
  const protobuf = encodePreparedTransaction(
    {
      sender: payer,
      receiver: requirements.payTo,
      amount: atomicToLedger(requirements.amount, 10) as string,
      instrumentId: requirements.extra.instrumentId,
      ...(executeBeforeMicros === undefined ? {} : { executeBeforeMicros }),
    },
    // A real payer exercises the admin-signed factory; the check needs it.
    { factory: {}, delivery: {} },
  );
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
    const { payload, requirements, payer, payerPublicKeys } = await buildSignedFixture();
    const result = await verifier.verify(payload, requirements, { payerPublicKeys });
    expect(result).toEqual(verified(payer));
  });

  it("rejects a hash that is not bound to the prepared transaction", async () => {
    const { payload, requirements, privateKey, payerPublicKeys } = await buildSignedFixture();
    const unrelatedHash = "aa".repeat(32);
    const maliciousPayload = {
      ...payload,
      payload: {
        ...payload.payload,
        preparedTxHash: unrelatedHash,
        signature: signatureToBase64(signHash(unrelatedHash, privateKey)),
      },
    };

    const result = await verifier.verify(maliciousPayload, requirements, { payerPublicKeys });

    expect(result).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_canton_signature_invalid",
      extensions: { detail: "hash_mismatch" },
    });
  });

  it("rejects an unsafe transaction graph before canonical hashing", async () => {
    const { payload, requirements, payerPublicKeys } = await buildSignedFixture();
    const cyclicTransaction = encodePreparedTransactionGraph(["0"], [{ id: "0", children: ["0"] }]);
    const maliciousPayload = {
      ...payload,
      payload: {
        ...payload.payload,
        preparedTransaction: gzipped(cyclicTransaction),
      },
    };

    expect(await verifier.verify(maliciousPayload, requirements, { payerPublicKeys })).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_canton_malformed_payload",
      extensions: { detail: "duplicate_reference" },
    });
  });

  it("rejects a scheme mismatch", async () => {
    const { payload, requirements, payerPublicKeys } = await buildSignedFixture();
    const result = await verifier.verify(
      { ...payload, accepted: { ...payload.accepted, scheme: "batch-settlement-canton" } },
      {
        ...requirements,
        scheme: "batch-settlement-canton",
      },
      { payerPublicKeys },
    );
    expect(result).toEqual({
      isValid: false,
      invalidReason: "unsupported_scheme",
    });
  });

  it("rejects a network the verifier is not bound to", async () => {
    const { payload, requirements, payerPublicKeys } = await buildSignedFixture();
    const other = MAINNET_NETWORK;
    const result = await verifier.verify(
      { ...payload, accepted: { ...payload.accepted, network: other } },
      { ...requirements, network: other },
      { payerPublicKeys },
    );
    expect(result).toEqual({
      isValid: false,
      invalidReason: "invalid_network",
    });
  });

  it("ignores a requirementsHash an older payer still sends, right or wrong", async () => {
    // The spec has no such field, and an unsigned hash binds nothing the decoded
    // transfer does not: it is not checked, so a stale one does not fail the payment.
    const { payload, requirements, payer, payerPublicKeys } = await buildSignedFixture();
    for (const requirementsHash of [requirementsHashOf(requirements), "deadbeef"]) {
      const p = { ...payload, payload: { ...payload.payload, requirementsHash } };
      expect(await verifier.verify(p, requirements, { payerPublicKeys })).toEqual(verified(payer));
    }
  });

  it("reports the transfer's sender as the payer, whatever payer an older payload names", async () => {
    // The spec's payload names no payer (Rule 8). A `payer` an older payer still
    // sends is ignored, so it can neither fail the payment nor change who it
    // reports as having paid.
    const { payload, requirements, payer, payerPublicKeys } = await buildSignedFixture();
    const p = { ...payload, payload: { ...payload.payload, payer: "mallory::1220wrong" } };
    expect(await verifier.verify(p, requirements, { payerPublicKeys })).toEqual(verified(payer));
  });

  it("refuses a key that is not the sender's: a transfer from another party, signed with this key", async () => {
    // What binds a key to the transfer's sender is the caller's lookup. The
    // keys passed here are the VICTIM's, because the victim is the sender, and
    // the signature was made with another party's. The hash and signature are
    // canonical and right for this transaction, so the signature failing under
    // every key the sender publishes is the only thing that refuses.
    const { payload, requirements, privateKey } = await buildSignedFixture();
    const victim = `victim::${fingerprintForPublicKey(toB64(getPublicKey(new Uint8Array(32).fill(9))))}`;
    const protobuf = encodePreparedTransaction(
      {
        sender: victim,
        receiver: requirements.payTo,
        amount: atomicToLedger(requirements.amount, 10) as string, // Canton Coin
        instrumentId: requirements.extra.instrumentId,
      },
      // A real payer exercises the admin-signed factory; the check needs it.
      { factory: {}, delivery: {} },
    );
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
    const victimKeys = [toB64(getPublicKey(new Uint8Array(32).fill(9)))];
    expect(await verifier.verify(p, requirements, { payerPublicKeys: victimKeys })).toEqual({
      isValid: false,
      invalidReason: "invalid_exact_canton_signature_invalid",
      payer: victim,
      extensions: { detail: "bad_signature" },
    });
  });

  it("rejects a bad signature", async () => {
    const { payload, requirements, payer, payerPublicKeys } = await buildSignedFixture();
    const p = {
      ...payload,
      payload: {
        ...payload.payload,
        signature: signatureToBase64("ff".repeat(64)),
      },
    };
    expect(await verifier.verify(p, requirements, { payerPublicKeys })).toEqual({
      isValid: false,
      invalidReason: "invalid_exact_canton_signature_invalid",
      payer,
      extensions: { detail: "bad_signature" },
    });
  });

  it("refuses a transfer that pays another party or another amount, naming its sender as the payer", async () => {
    // The binding runs on the decoded transfer, and the payer it reports is that
    // transfer's sender: the payload names none.
    const { payload, requirements, payer, payerPublicKeys } = await buildSignedFixture();
    // Each field has its own code in the spec; the older code and the field
    // ride along in extensions.
    const cases = [
      [{ ...requirements, payTo: "someoneelse::1220" }, "receiver", "invalid_exact_canton_merchant_mismatch"],
      [{ ...requirements, amount: "100000001" }, "amount", "invalid_exact_canton_amount_mismatch"],
      [
        { ...requirements, extra: { ...requirements.extra, instrumentId: { id: "USDC", admin: "DSO::1220dso" } } },
        "instrument",
        "invalid_exact_canton_instrument_id_mismatch",
      ],
      // Its own code: `transfer_mismatch` here would be a protocol-level code
      // of ours in the slot a spec-written client matches on.
      [
        { ...requirements, extra: { ...requirements.extra, synchronizerId: "other-domain::1220ffff" } },
        "synchronizer",
        "invalid_exact_canton_synchronizer_mismatch",
      ],
    ] as const;
    for (const [req, detail, invalidReason] of cases) {
      expect(await verifier.verify(payload, req, { payerPublicKeys })).toEqual({
        isValid: false,
        invalidReason,
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

  it("tells a transaction the schema cannot read apart from a bad gzip member", async () => {
    // Gunzips fine, then carries a field the schema does not define. The guard
    // refuses it as `structure_undecodable`, not the `undecodable` a member
    // that will not gunzip answers, so the two causes stay apart.
    const { payload, requirements, payer, payerPublicKeys } = await buildSignedFixture();
    const preparedTransaction = encodePreparedTransaction(
      {
        sender: payer,
        receiver: requirements.payTo,
        amount: atomicToLedger(requirements.amount, 10) as string, // Canton Coin
        instrumentId: requirements.extra.instrumentId,
      },
      { extra: { prepared: wrap(15, stringField(1, "unsigned")) } },
    );
    const p = { ...payload, payload: { ...payload.payload, preparedTransaction: gzipped(preparedTransaction) } };
    expect(await verifier.verify(p, requirements, { payerPublicKeys })).toEqual({
      isValid: false,
      invalidReason: "invalid_exact_canton_malformed_payload",
      extensions: { detail: "structure_undecodable" },
    });
  });

  it("rejects a prepared transaction whose transfer node is also encoded as another node type", async () => {
    // Correctly signed and the transfer matches, but protobuf keeps the last
    // member of a oneof, so Canton would read this node as a create.
    const { payload, requirements, payer, payerPublicKeys } = await buildSignedFixture();
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
    expect(await verifier.verify(p, requirements, { payerPublicKeys })).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_canton_malformed_payload",
      extensions: { detail: "undecodable" },
    });
  });

  it("rejects a prepared transaction that lists a second node under the transfer node's id", async () => {
    // Canton keeps the last node of a repeated id, so it would run the create.
    const { payload, requirements, payer, payerPublicKeys } = await buildSignedFixture();
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
    expect(await verifier.verify(p, requirements, { payerPublicKeys })).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_canton_malformed_payload",
      extensions: { detail: "duplicate_node_id" },
    });
  });

  it("reads the signature only as canonical base64 of 64 bytes", async () => {
    // The signed transfer's deadline is now plus the horizon, so the signature
    // changes with the clock, and about one in fifteen has no "+" or "/" for the
    // URL-safe variant to replace. Step the horizon until it has one.
    let fixture = await buildSignedFixture();
    for (let s = 121; s < 200 && !/[+/]/.test(fixture.payload.payload.signature); s++) {
      fixture = await buildSignedFixture({ executeBeforeSeconds: s });
    }
    const { payload, requirements, signatureHex, payer, payerPublicKeys } = fixture;
    const signature = payload.payload.signature;
    const nonCanonical = withPaddingBitSet(signature);
    // Decodes to the very same signature, so only the canonical check refuses it.
    expect(atob(nonCanonical)).toBe(atob(signature));
    const urlSafe = signature.replace(/\+/g, "-").replace(/\//g, "_");
    // The loop above made sure it has a "+" or a "/" to replace.
    expect(urlSafe).not.toBe(signature);
    // Hex is what a payer built against the old field sends. Its 128 digits are
    // valid base64 too, so the 64-byte check is what refuses it.
    for (const variant of [signatureHex, signature.replace(/=+$/, ""), nonCanonical, urlSafe, ` ${signature}`]) {
      const p = { ...payload, payload: { ...payload.payload, signature: variant } };
      expect(await verifier.verify(p, requirements, { payerPublicKeys })).toEqual({
        isValid: false,
        invalidReason: "invalid_exact_canton_signature_invalid",
        payer,
        extensions: { detail: "malformed_encoding" },
      });
    }
  });

  it("refuses a signature of megabytes at the encoding, rather than throwing", async () => {
    // Unbounded, the base64 regex runs out of backtracking stack at about 4.5M
    // characters and throws.
    const { payload, requirements, payerPublicKeys } = await buildSignedFixture();
    const p = { ...payload, payload: { ...payload.payload, signature: "A".repeat(5 * 1024 * 1024) } };
    expect(await verifier.verify(p, requirements, { payerPublicKeys })).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_canton_signature_invalid",
      extensions: { detail: "malformed_encoding" },
    });
  });

  it("reads preparedTxHash only as 64 lower-case hex digits", async () => {
    const { payload, requirements, seedB64, payerPublicKeys } = await buildSignedFixture();
    const hash = payload.payload.preparedTxHash;
    // Each variant carries a valid signature over its own bytes, so the
    // encoding check is the only thing that can refuse it. Upper case is the
    // same 32 bytes that were signed.
    for (const preparedTxHash of [hash.toUpperCase(), `1220${hash}`, `${hash}00`, hash.slice(2)]) {
      const signature = signatureToBase64(signHash(preparedTxHash, seedB64));
      const p = { ...payload, payload: { ...payload.payload, preparedTxHash, signature } };
      expect(await verifier.verify(p, requirements, { payerPublicKeys })).toMatchObject({
        isValid: false,
        invalidReason: "invalid_exact_canton_signature_invalid",
        extensions: { detail: "malformed_encoding" },
      });
    }
  });

  it("refuses a proof field that is not there as missing_proof (Rule 2)", async () => {
    const { payload, requirements, payerPublicKeys } = await buildSignedFixture();
    for (const field of ["preparedTransaction", "preparedTxHash", "signature"] as const) {
      const { [field]: _omit, ...without } = payload.payload;
      for (const inner of [without, { ...payload.payload, [field]: 7 }]) {
        const p = { ...payload, payload: inner } as unknown as CantonPaymentPayload;
        expect(await verifier.verify(p, requirements, { payerPublicKeys })).toEqual({
          isValid: false,
          invalidReason: "invalid_exact_canton_missing_proof",
          extensions: { detail: "proof_fields_missing" },
        });
      }
    }
  });

  it("refuses an empty proof field as malformed_payload, saying which one", async () => {
    // Present but not well-formed. An empty hash or signature failed the shape
    // check, and an empty transaction failed to decode — one code, two causes,
    // which is what `detail` is for.
    const { payload, requirements, payerPublicKeys } = await buildSignedFixture();
    const cases = [
      ["preparedTxHash", { detail: "payload_shape" }],
      ["signature", { detail: "payload_shape" }],
      ["preparedTransaction", { detail: "undecodable" }],
    ] as const;
    for (const [field, extensions] of cases) {
      const p = { ...payload, payload: { ...payload.payload, [field]: "" } };
      expect(await verifier.verify(p, requirements, { payerPublicKeys })).toEqual({
        isValid: false,
        invalidReason: "invalid_exact_canton_malformed_payload",
        extensions,
      });
    }
  });

  it("reports a payload with no proof at all as missing_proof, naming nobody", async () => {
    // The key used to be checked here, ahead of the proof, and gave this refusal
    // its `missing_public_key` reason. The payload carries no key now (#105), so
    // what is left is the proof's own absence — refused before anything decodes,
    // which is why no payer is named.
    const { payload, requirements, payerPublicKeys } = await buildSignedFixture();
    const { signature: _sig, ...noSignature } = payload.payload;
    // `[]` is an object to the shape check, so it reaches the proof fields and
    // finds none; only a non-object is refused before that. Two causes under
    // one code, told apart by `detail`.
    const cases = [
      [noSignature, "proof_fields_missing"],
      [[], "proof_fields_missing"],
      ["", "payload_missing"],
      [null, "payload_missing"],
    ] as const;
    for (const [inner, detail] of cases) {
      const p = { ...payload, payload: inner } as unknown as CantonPaymentPayload;
      expect(await verifier.verify(p, requirements, { payerPublicKeys })).toEqual({
        isValid: false,
        invalidReason: "invalid_exact_canton_missing_proof",
        extensions: { detail },
      });
    }
  });

  it("reads preparedTransaction only as one gzip member within the caps", async () => {
    const { payload, requirements, protobuf, payerPublicKeys } = await buildSignedFixture();
    const bytes = Buffer.from(protobuf, "base64");
    // The same transfer padded past the decompressed cap with an unknown
    // field (15, length-delimited); about 100 bytes gzipped. The decoder used to
    // skip that field, so the cap was the only thing that could refuse it — it
    // now refuses the unknown field itself, since the signing hash does not
    // cover one. Either way the payload is refused, and the caps themselves are
    // pinned directly in prepared-tx-codec.test.ts.
    //
    // Derived from the cap rather than written down. The literal here was
    // calibrated against 64 KiB; raising the bound to 72 slid the padded
    // transfer under it, the gunzip succeeded, and the unknown field was
    // refused as invalid_prepared_transaction_structure instead. That the two
    // paths answer differently is why this failed rather than quietly
    // measuring the same rule twice.
    const pad = DEFAULT_MAX_DECOMPRESSED_BYTES + 1024;
    const padded = Buffer.concat([bytes, Buffer.from([(15 << 3) | 2, 0x80 | (pad & 0x7f), 0x80 | ((pad >> 7) & 0x7f), pad >> 14]), Buffer.alloc(pad)]);
    expect(decodePreparedTransaction(padded.toString("base64"))).toBeNull();
    const overCap = gzipPreparedTransaction(padded);
    // One gzip member and then a byte: refused by the single-member rule.
    const trailing = Buffer.concat([Buffer.from(payload.payload.preparedTransaction, "base64"), Buffer.from([0])]).toString("base64");
    // The protobuf without gzip is what a payer built before this sends.
    for (const preparedTransaction of [protobuf, overCap, trailing]) {
      const p = { ...payload, payload: { ...payload.payload, preparedTransaction } };
      expect(await verifier.verify(p, requirements, { payerPublicKeys })).toEqual({
        isValid: false,
        invalidReason: "invalid_exact_canton_malformed_payload",
        extensions: { detail: "undecodable" },
      });
    }
  });

  it("refuses a payload without assetTransferMethod, or with another value, at the shape check", async () => {
    // Everything else is right: the signature verifies and the transfer matches.
    const { payload, requirements, payerPublicKeys } = await buildSignedFixture();
    const { assetTransferMethod: _omit, ...withoutMethod } = payload.payload;
    const variants = [withoutMethod, { ...payload.payload, assetTransferMethod: "transfer-preapproval" }];
    for (const inner of variants) {
      const p = { ...payload, payload: inner } as unknown as CantonPaymentPayload;
      expect(await verifier.verify(p, requirements, { payerPublicKeys })).toEqual({
        isValid: false,
        invalidReason: "invalid_exact_canton_malformed_payload",
        extensions: { detail: "payload_shape" },
      });
    }
  });

  it("does not read the pre-spec field names", async () => {
    const { payload, requirements, payerPublicKeys } = await buildSignedFixture();
    const { preparedTxHash, signature, ...rest } = payload.payload;
    const p = {
      ...payload,
      payload: { ...rest, preparedTransactionHash: preparedTxHash, partySignature: signature },
    };
    expect(await verifier.verify(p, requirements, { payerPublicKeys })).toEqual({
      isValid: false,
      invalidReason: "invalid_exact_canton_missing_proof",
      extensions: { detail: "proof_fields_missing" },
    });
  });

  it("refuses a transfer whose deadline has passed, or is about to (Rule 10)", async () => {
    // The margin exists because settling is not instantaneous: accepting at
    // T-1ms guarantees the wasted relay it is meant to avoid.
    const fixture = await buildSignedFixture();
    const nowMicros = BigInt(Date.now()) * 1000n;
    for (const micros of [nowMicros - 60_000_000n, nowMicros, nowMicros + 1_000_000n]) {
      expect(await verifier.verify(await reDeadline(fixture, micros), fixture.requirements, { payerPublicKeys: fixture.payerPublicKeys })).toMatchObject({
        isValid: false,
        invalidReason: "invalid_exact_canton_expired",
      });
    }
  });

  it("refuses a transfer that carries no deadline at all", async () => {
    // Not "no deadline, therefore fine": a real transfer always has one, and
    // reading an absent field as unlimited would make Rule 10 skippable by
    // leaving the field out.
    const fixture = await buildSignedFixture();
    expect(await verifier.verify(await reDeadline(fixture, undefined), fixture.requirements, { payerPublicKeys: fixture.payerPublicKeys })).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_canton_expired",
    });
  });

  it("binds the memo when the merchant quotes one (Rule 12)", async () => {
    const quoted = await buildSignedFixture({ memo: "invoice-2024-001" });
    expect(await verifier.verify(quoted.payload, quoted.requirements, { payerPublicKeys: quoted.payerPublicKeys })).toMatchObject({ isValid: true });

    // Signed a different memo, or none, against requirements that quote one.
    for (const memo of ["invoice-2024-002", undefined]) {
      const other = await buildSignedFixture(memo === undefined ? {} : { memo });
      expect(await verifier.verify(other.payload, quoted.requirements, { payerPublicKeys: other.payerPublicKeys })).toMatchObject({
        invalidReason: "invalid_exact_canton_memo_mismatch",
        extensions: { detail: "memo" },
      });
    }
  });

  it("refuses a memo the merchant did not quote", async () => {
    // `x402.memo` is the scheme's key, not the payer's. Letting a payer name an
    // order the merchant never quoted lets a cheap payment reconcile against an
    // expensive one, for any merchant that matches ledger payments by memo.
    const { requirements, payerPublicKeys } = await buildSignedFixture();
    const withMemo = await buildSignedFixture({ memo: "someone else's order" });
    expect(await verifier.verify(withMemo.payload, requirements, { payerPublicKeys })).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_canton_memo_mismatch",
      extensions: { detail: "memo" },
    });
  });

  it("refuses an unquoted memo hidden behind a blank label", async () => {
    // The check above was walked straight past. Daml binds a record by label
    // only when EVERY field is labeled; blanking `meta` alone leaves the engine
    // in declaration order, so the transfer settles carrying the memo, while a
    // reader that switched to the label path on ANY label found no `meta` and
    // reported none. Verify then certified "this transfer carries no memo"
    // about a transfer carrying one.
    const { requirements, payerPublicKeys } = await buildSignedFixture();
    const hidden = await buildSignedFixture({
      memo: "order-EXPENSIVE-999",
      blankLabels: ["meta"],
    });
    expect(await verifier.verify(hidden.payload, requirements, { payerPublicKeys })).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_canton_memo_mismatch",
      extensions: { detail: "memo" },
    });
  });

  it("reports no resolvable key for the payer as signature_invalid, naming the sender", async () => {
    // The payload carries no key, so there is nothing to blank or omit: this is
    // the caller finding none in the party's topology. It is refused AFTER the
    // transfer decodes, which is why the payer is named where the old
    // missing-key refusal named nobody.
    const { payload, requirements, payer } = await buildSignedFixture();
    expect(await verifier.verify(payload, requirements, { payerPublicKeys: [] })).toEqual({
      isValid: false,
      invalidReason: "invalid_exact_canton_signature_invalid",
      payer,
      extensions: { detail: "no_payer_key" },
    });
  });

  it("refuses keys that are the wrong party's, or not keys at all, as bad_signature", async () => {
    // Both reach step 13 and simply fail to verify: a key that cannot have signed
    // is not special-cased, because the lookup by party is what binds the set.
    const { payload, requirements, payer } = await buildSignedFixture();
    for (const keys of [[OTHER_PARTY_KEY], [toB64(new Uint8Array(31))]]) {
      expect(await verifier.verify(payload, requirements, { payerPublicKeys: keys })).toEqual({
        isValid: false,
        invalidReason: "invalid_exact_canton_signature_invalid",
        payer,
        extensions: { detail: "bad_signature" },
      });
    }
  });

  it("accepts a key the party publishes that is NOT the one its `::` suffix names", async () => {
    // THE CASE THE ANY-KEY RULE EXISTS FOR, and the only one in this file that
    // tells the two behaviours apart. A party's `::` suffix is its NAMESPACE
    // fingerprint, which equals a signing key's only while it publishes one;
    // mid-rotation it publishes two, and the new key's fingerprint is not the
    // suffix. Every other fixture here signs with the key the suffix names, so
    // narrowing to that key passes all of them — an earlier version of this
    // test included. Re-add the filter and this is what fails.
    const { payload, requirements, payer, payerPublicKeys } = await buildSignedFixture();
    const namespaceKey = payerPublicKeys[0] as string;
    const rotatedSeed = new Uint8Array(32).fill(11);
    const rotatedKey = toB64(getPublicKey(rotatedSeed));
    const suffix = payer.split("::")[1] as string;
    // What makes the case: the signer's fingerprint is NOT the party's suffix.
    expect(fingerprintForPublicKey(namespaceKey)).toBe(suffix);
    expect(fingerprintForPublicKey(rotatedKey)).not.toBe(suffix);

    // The same transaction, signed by the rotated key instead of the namespace one.
    const p = {
      ...payload,
      payload: {
        ...payload.payload,
        signature: signatureToBase64(signHash(payload.payload.preparedTxHash, toB64(rotatedSeed))),
      },
    };
    // Namespace key first, so this also pins that a key which does not verify
    // is not the end of the search.
    expect(await verifier.verify(p, requirements, { payerPublicKeys: [namespaceKey, rotatedKey] })).toEqual(
      // signedBy is the ROTATED key, not the party's `::` suffix: that is the
      // value a submission must carry, and the suffix would be the wrong one.
      verified(payer, fingerprintForPublicKey(rotatedKey)),
    );
    // And it is genuinely the rotated key that signed: without it, refused.
    expect(await verifier.verify(p, requirements, { payerPublicKeys: [namespaceKey] })).toEqual({
      isValid: false,
      invalidReason: "invalid_exact_canton_signature_invalid",
      payer,
      extensions: { detail: "bad_signature" },
    });
  });

  it("refuses a payment with no usable accepted, or a pre-spec envelope, with unsupported_scheme rather than a throw", async () => {
    const { payload, requirements, payerPublicKeys } = await buildSignedFixture();
    const { accepted: _omit, ...noAccepted } = payload;
    const variants = [
      noAccepted,
      { ...noAccepted, accepted: null },
      { ...noAccepted, accepted: [] },
      { ...noAccepted, accepted: "exact" },
      // The pre-spec envelope: the scheme and network at the top level.
      { ...noAccepted, scheme: "exact", network: NETWORK },
    ];
    for (const p of variants) {
      expect(await verifier.verify(p as unknown as CantonPaymentPayload, requirements, { payerPublicKeys })).toEqual({
        isValid: false,
        invalidReason: "unsupported_scheme",
      });
    }
  });

  it("refuses an x402Version other than 2", async () => {
    const { payload, requirements, payerPublicKeys } = await buildSignedFixture();
    const p = { ...payload, x402Version: 1 } as unknown as CantonPaymentPayload;
    expect(await verifier.verify(p, requirements, { payerPublicKeys })).toEqual({
      isValid: false,
      invalidReason: "invalid_x402_version",
    });
  });

  it("checks accepted only for Rule 1: the rest of the verdict depends on paymentRequirements", async () => {
    // The spec binds the transfer to paymentRequirements; accepted only has to
    // name the same scheme and network. One that differs elsewhere verifies.
    const { payload, requirements, payer, payerPublicKeys } = await buildSignedFixture();
    const accepted = { ...requirements, amount: "1", payTo: "someoneelse::1220" };
    expect(await verifier.verify({ ...payload, accepted }, requirements, { payerPublicKeys })).toEqual(verified(payer));
  });

  it("verifies a payment carrying resource and extensions, or null for either", async () => {
    const { payload, requirements, payer, payerPublicKeys } = await buildSignedFixture();
    const variants = [
      { ...payload, resource: { url: "https://merchant.example/r" }, extensions: { "x-ext": { info: {}, schema: {} } } },
      { ...payload, resource: null, extensions: null },
    ];
    for (const p of variants) {
      expect(await verifier.verify(p, requirements, { payerPublicKeys })).toEqual(verified(payer));
    }
  });

  it("accepts a payload without hashingSchemeVersion, which the spec reads as V2", async () => {
    const { payload, requirements, payer, payerPublicKeys } = await buildSignedFixture();
    const { hashingSchemeVersion: _omit, ...innerNoScheme } = payload.payload;
    const p = { ...payload, payload: innerNoScheme };
    expect(await verifier.verify(p, requirements, { payerPublicKeys })).toEqual(verified(payer));
  });

  // A signed TransferFactory_Transfer either delivers to the receiver now or
  // leaves a pending instruction the payer can withdraw. Only the consequences
  // say which, and relaying the second commits the payer's funds without
  // paying the merchant.
  describe("the delivery consequence", () => {
    const refusal = (detail: string) => ({
      isValid: false,
      invalidReason: "invalid_exact_canton_preapproval_missing",
      extensions: { detail },
    });

    it("refuses a transfer that delivers nothing", async () => {
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({ delivery: null });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(refusal("no_direct_delivery"));
    });

    it("refuses a consequence that is not a delivery choice", async () => {
      // The pending path exercises something else and creates an instruction.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        delivery: { choiceId: "AllocationFactory_TransferInternal" },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(refusal("no_direct_delivery"));
    });

    it("refuses a delivery choice whose template module alone is wrong", async () => {
      // Module and entity get a test each, so neither arm can be dropped.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        delivery: { moduleName: "Splice.Wallet" },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(refusal("no_direct_delivery"));
    });

    it("refuses a delivery choice whose template entity alone is wrong", async () => {
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        delivery: { entityName: "Impostor" },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(refusal("no_direct_delivery"));
    });

    it("refuses two deliveries, since binding either leaves the other unchecked", async () => {
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({ delivery: { duplicate: true } });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(refusal("delivery_ambiguous"));
    });

    it("refuses a delivery whose preapproval the transaction never discloses", async () => {
      // A bare contract id says nothing about whose preapproval it is.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        delivery: { omitDisclosure: true },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(refusal("delivery_unresolved"));
    });

    it("refuses a preapproval belonging to someone else", async () => {
      // THE point of the binding: a live preapproval for another receiver
      // grants this merchant nothing.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        delivery: { receiver: "someone-else::1220other" },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(refusal("delivery_receiver"));
    });

    it("refuses a preapproval under another issuer", async () => {
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        delivery: { dso: "other-dso::1220other" },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(refusal("delivery_admin"));
    });

    it("refuses a disclosure carrying an extra signatory", async () => {
      // Not a stock preapproval: a relay that appends a party is presenting
      // something else.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        delivery: {
          signatories: ["DSO::1220dso", "merchant::1220merch", "app-provider::1220prov", "extra::1220x"],
        },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(refusal("delivery_signatories"));
    });

    it("refuses a disclosure missing one of the trio", async () => {
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        delivery: { signatories: ["DSO::1220dso", "merchant::1220merch", "stranger::1220s"] },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(refusal("delivery_signatories"));
    });

    it("accepts a merchant that provides its own preapproval", async () => {
      // A merchant running its own validator is its own provider, so the
      // disclosure carries two signatories, not three. That is a stock
      // preapproval the ledger delivers through — the reference facilitator
      // says so explicitly — and counting to three would make such a merchant
      // permanently unpayable.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        delivery: {
          provider: "merchant::1220merch",
          signatories: ["DSO::1220dso", "merchant::1220merch"],
        },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject({ isValid: true });
    });

    it("refuses a preapproval where one party fills all three roles", async () => {
      // No issuer distinct from the receiver: the degenerate case the
      // reference facilitator also refuses. The instrument's admin has to be
      // that party too, or the admin binding refuses it first and this would
      // pass for the wrong reason.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        instrumentId: { id: "Amulet", admin: "merchant::1220merch" },
        delivery: {
          dso: "merchant::1220merch",
          provider: "merchant::1220merch",
          signatories: ["merchant::1220merch"],
        },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        refusal("delivery_signatories"),
      );
    });

    it("refuses a delivery that sits under a rollback", async () => {
      // A rolled-back consequence happened to nobody, so it delivers nothing —
      // the decoder must not report it and the rule must not count it.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        delivery: { rolledBack: true },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        refusal("no_direct_delivery"),
      );
    });

    it("accepts Canton Coin's preapproval delivery, bound to this merchant", async () => {
      // What the captured LocalNet payment carries.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture();
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject({ isValid: true });
    });

    const registryDelivery = {
      choiceId: "TransferRule_DirectTransfer",
      moduleName: "Utility.Registry.V0.Rule.Transfer",
      entityName: "TransferRule",
    };

    it("accepts a registry token's own direct transfer", async () => {
      // Reached only because the instrument is NOT Canton Coin.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        instrumentId: usdx,
        delivery: registryDelivery,
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject({ isValid: true });
    });

    it("refuses a Canton Coin payment carrying a registry delivery beside it", async () => {
      // THE OTHER ARM IS NOT LOOKED AT. The instrument picks an arm, that arm
      // finds its one node and binds it, and the filter for the other arm never
      // runs — so a second delivery of the other shape rides along, moving
      // whatever it likes to whoever it likes, read by nothing.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        second: {
          ...registryDelivery,
          delivers: { receiver: "mallory::1220bad", amount: "999.0" },
        },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        refusal("delivery_unchecked"),
      );
    });

    it("refuses a registry payment carrying a preapproval send beside it", async () => {
      // The same hole from the other side, so neither arm is pinned by the
      // other's test.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        instrumentId: usdx,
        delivery: registryDelivery,
        second: {
          choiceId: "TransferPreapproval_SendV2",
          moduleName: "Splice.AmuletRules",
          entityName: "TransferPreapproval",
          delivers: { receiver: "mallory::1220bad", amount: "999.0" },
        },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        refusal("delivery_unchecked"),
      );
    });

    it.fails("KNOWN GAP: a consequence of neither arm still rides along unchecked", async () => {
      // The cross-arm guard closes a second node of the OTHER delivery arm. It
      // does not close a node that is no delivery at all — an arbitrary choice
      // on an arbitrary template is matched by neither filter, so neither arm
      // looks at it. Closing this needs a whole-tree allowlist, which has to
      // tolerate the Archive every honest capture carries.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        second: {
          choiceId: "Drain_Everything",
          moduleName: "Evil.Module",
          entityName: "Evil",
          delivers: { receiver: "mallory::1220bad", amount: "999.0" },
        },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject({ isValid: false });
    });

    it("refuses a dust send against a correctly bound preapproval", async () => {
      // Binding the preapproval says WHO gets paid, not HOW MUCH. Every other
      // check here passes for this tree: the preapproval is the merchant's, its
      // signatories are right, the root says the quoted amount. Only the send's
      // own amount is a fraction of it.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        delivery: { sendAmount: "0.0000000001" },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        refusal("delivery_amount"),
      );
    });

    it("reads the send's amount as a decimal, so spelling alone does not refuse", async () => {
      // The control for the check above. `atomicToLedger` TRIMS trailing zeros,
      // so the root carries "0.01"; the send spells the same amount padded, as
      // every real capture does ("0.0100000000"). One amount on-ledger, and
      // refusing over spelling would refuse honest bytes — so this must still
      // accept, which is what tells the amount check apart from a string
      // compare. Written the other way round first, it compared "0.01" with
      // "0.01" and proved nothing.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        delivery: { sendAmount: "0.0100000000" },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject({ isValid: true });
    });

    it("refuses a send whose argument carries no amount at all", async () => {
      // The absent case, which nothing pinned: a field the reader cannot find
      // is not a match, it is a missing field. Treating `undefined` as equal to
      // the root would let a send with no readable amount deliver anything.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        delivery: { omitDelivers: true },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        refusal("delivery_amount"),
      );
    });

    it("refuses the legacy TransferPreapproval_Send", async () => {
      // Found, not ignored: it is in the locator set, so the answer names the
      // legacy choice rather than reporting no delivery at all. Its argument
      // layout is unmeasured, so its amount cannot be bound.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        delivery: { choiceId: "TransferPreapproval_Send" },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        refusal("delivery_legacy_send"),
      );
    });

    it("still reads a preapproval whose disclosure has ONE blank label", async () => {
      // The engine binds a record by label only when EVERY field carries one;
      // one blank label puts the whole disclosure in declaration order. Reading
      // `some` instead sent this down the label path, where the blanked field
      // matched nothing and an honest preapproval was refused as unresolved.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        delivery: { blankDisclosureLabels: ["dso"] },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject({ isValid: true });
    });

    it("refuses a disclosure whose label contradicts the position it sits in", async () => {
      // Declaration order binds once any label is blank, so a label naming a
      // different field than the one declared at its index is a contradiction.
      // This is the reader that decides WHOSE preapproval the delivery spends.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        delivery: {
          blankDisclosureLabels: ["dso"],
          // Not another field's name: that collides, and the repeated-label
          // guard would refuse the blob before the field reader was consulted.
          relabelDisclosure: { receiver: "recipient" },
        },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        refusal("delivery_unresolved"),
      );
    });

    it("refuses a registry delivery that is anchored to nothing", async () => {
      // THE DECOY. A bare node named TransferRule_DirectTransfer, exercising no
      // disclosed contract, carrying a copy of the root's own transfer record,
      // used to turn a tree this rule exists to refuse into a valid payment:
      // the arm read what the node CLAIMED it moved and never where it came
      // from. The preapproval arm has always required its contract to resolve.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        instrumentId: usdx,
        delivery: { ...registryDelivery, omitDisclosure: true },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        refusal("delivery_unresolved"),
      );
    });

    it("refuses a registry delivery whose rule the instrument's issuer did not sign", async () => {
      // Anchored, but to someone else's contract. The rule being exercised has
      // to belong to the issuer the quote names, or the anchor proves only that
      // SOME contract was disclosed.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        instrumentId: usdx,
        delivery: {
          ...registryDelivery,
          signatories: ["someone-else::1220other", "bridge-operator::1220bridge"],
        },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        refusal("delivery_admin"),
      );
    });

    it("does NOT let a registry marker stand in for Canton Coin's delivery", async () => {
      // The arm is chosen by the instrument, never by what the tree contains.
      // Choosing it from the nodes would let a payer pick the weaker rule by
      // writing the node that selects it — one string, whole rule gone.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        delivery: registryDelivery,
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        refusal("no_direct_delivery"),
      );
    });

    const usdx = { id: "USDX", admin: "usdx-issuer::1220issuer" };

    it("refuses a registry delivery that pays someone else", async () => {
      // The leg that actually pays must move what the signed root said it
      // would. The reference facilitator reports catching real bytes this way.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        instrumentId: usdx,
        delivery: { ...registryDelivery, delivers: { receiver: "mallory::1220bad" } },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        refusal("delivery_receiver"),
      );
    });

    it("refuses a registry delivery for a smaller amount than the root", async () => {
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        instrumentId: usdx,
        delivery: { ...registryDelivery, delivers: { amount: "0.0000000001" } },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(refusal("delivery_amount"));
    });

    it("reads the amount as a decimal, so spelling alone does not refuse", async () => {
      // The root carries "0.0100000000"; "0.01" is the same amount written
      // short, and the ledger would move exactly as much.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        instrumentId: usdx,
        delivery: { ...registryDelivery, delivers: { amount: "0.01" } },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject({ isValid: true });
    });

    it("refuses a registry delivery from another sender", async () => {
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        instrumentId: usdx,
        delivery: { ...registryDelivery, delivers: { sender: "someone::1220else" } },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(refusal("delivery_sender"));
    });

    it("refuses a registry delivery that carries no transfer record", async () => {
      // Nothing to hold to the root: the node names the choice and says
      // nothing about what it moves.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        instrumentId: usdx,
        delivery: { ...registryDelivery, omitDelivers: true },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        refusal("delivery_unresolved"),
      );
    });

    it("refuses a registry delivery under another issuer", async () => {
      // Id and admin get a test each, so neither arm can be dropped unnoticed.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        instrumentId: usdx,
        delivery: {
          ...registryDelivery,
          delivers: { instrumentId: { id: usdx.id, admin: "other-issuer::1220other" } },
        },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        refusal("delivery_instrument"),
      );
    });

    it("refuses a registry delivery of another instrument", async () => {
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        instrumentId: usdx,
        delivery: {
          ...registryDelivery,
          delivers: { instrumentId: { id: "OTHER", admin: usdx.admin } },
        },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        refusal("delivery_instrument"),
      );
    });

    it("refuses a registry token delivering twice", async () => {
      // One transfer pays once.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        instrumentId: usdx,
        delivery: { ...registryDelivery, duplicate: true },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        refusal("delivery_ambiguous"),
      );
    });

    it("refuses a registry token with no delivery at all", async () => {
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        instrumentId: usdx,
        delivery: null,
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        refusal("no_direct_delivery"),
      );
    });
  });

  // The transfer choice must be exercised through a real transfer factory. The
  // payer picks the contract, so a forged one is the attack: these fix what
  // "real" means. Each fixture is re-signed, so the refusal is this rule's and
  // not a stale signature.
  describe("what the transfer leaves behind", () => {
    const malformed = (detail: string) => ({
      isValid: false,
      invalidReason: "invalid_exact_canton_malformed_payload",
      extensions: { detail },
    });

    it("refuses a contract the sender signs that the issuer did not", async () => {
      // THE FORGED CREATE. The quoted payment is delivered honestly; this rides
      // beside it. A contract the sender signs carries the sender's authority
      // into whatever choices it offers, exercised later by whoever controls
      // them — long after this payment looked fine. The reference facilitator
      // reports measuring exactly this against its captured payments.
      // The payer is a fingerprint of the fixture's key, so learn it first
      // rather than hardcoding a party that would never match the sender and
      // leave the rule skipped.
      const { payer } = await buildSignedFixture({});
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        creates: [{ signatories: [payer, "mallory::1220bad"] }],
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        malformed("create_unissued"),
      );
    });

    it("accepts a contract the sender signs WITH the issuer, as every real one is", async () => {
      // The control. `Amulet [DSO, owner]` is the payer's change on every real
      // Canton Coin capture; refusing it would refuse every honest payment.
      const { payer, payerPublicKeys } = await buildSignedFixture({});
      const withChange = await buildSignedFixture({
        creates: [{ signatories: ["DSO::1220dso", payer] }],
      });
      expect(await verifier.verify(withChange.payload, withChange.requirements, { payerPublicKeys })).toMatchObject({
        isValid: true,
      });
    });

    it("leaves a create the sender does NOT sign alone", async () => {
      // The merchant's own holding and the featured-app marker are created
      // without the sender on them. They grant nothing of the payer's, so the
      // rule does not reach them — which is what keeps it off honest traffic.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        creates: [{ signatories: ["merchant::1220merch", "someone::1220else"] }],
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject({ isValid: true });
    });
  });

  describe("the exercised factory contract", () => {
    const factoryRefusal = (detail: string) => ({
      isValid: false,
      invalidReason: "invalid_exact_canton_malformed_payload",
      extensions: { detail },
    });

    it("refuses an exercise on a contract the transaction never discloses", async () => {
      // No input_contracts entry: nothing says what was exercised.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        factory: { inputContracts: [] },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        factoryRefusal("factory_unresolved"),
      );
    });

    it("refuses an exercise whose id matches no disclosure, though one is present", async () => {
      // The resolution has to find the contract the exercise NAMES, not just
      // some contract in the input set. Without the id comparison this passes
      // on a perfectly good factory sitting under a different id, and the
      // exercised contract reported is one the transfer never touched.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        factory: { inputContracts: [{ contractId: "00" + "ab".repeat(31) }] },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        factoryRefusal("factory_unresolved"),
      );
    });

    it("refuses an exercised id disclosed more than once", async () => {
      // Two entries for one id: which one was exercised is not decidable.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        factory: { inputContracts: [{}, {}] },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        factoryRefusal("factory_unresolved"),
      );
    });

    it("refuses a disclosure whose template module alone disagrees", async () => {
      // Exercising one template against a contract disclosed as another:
      // believing either one over the other would be a guess. Module and
      // entity get a test each, so neither arm can be dropped unnoticed.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        factory: { inputContracts: [{ templateId: { moduleName: "Splice.Wallet" } }] },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        factoryRefusal("factory_unresolved"),
      );
    });

    it("refuses a disclosure whose template entity alone disagrees", async () => {
      // Separate from the test above, which changes module AND entity: one
      // fixture moving both leaves either arm free to be dropped.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        factory: { inputContracts: [{ templateId: { entityName: "NotTheSameEntity" } }] },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        factoryRefusal("factory_unresolved"),
      );
    });

    it("refuses an exercise that names no contract at all", async () => {
      // The id decodes as "" when absent, so without the guard it would match
      // a disclosure that is equally blank and read as a resolved factory.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        factory: { contractId: "" },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        factoryRefusal("factory_unresolved"),
      );
    });

    it("refuses a disclosure whose package name disagrees with the exercise's", async () => {
      // The package NAME is what an upgrade preserves, so unlike the package
      // id the two sides must agree on it.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        factory: { inputContracts: [{ packageName: "not-splice-amulet" }] },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        factoryRefusal("factory_unresolved"),
      );
    });

    it("refuses a choice exercised on the template directly, with no interface", async () => {
      // A transfer factory's choice is defined on the interface. No interface
      // means some other choice that merely shares the name.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        factory: { omitInterfaceId: true },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        factoryRefusal("factory_interface"),
      );
    });

    it("refuses an interface whose module is not the Token Standard's", async () => {
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        factory: { interfaceId: { moduleName: "Splice.Wallet.Impostor" } },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        factoryRefusal("factory_interface"),
      );
    });

    it("refuses an interface whose entity is not TransferFactory", async () => {
      // Checked separately from the module: one test changing both at once
      // would leave either arm free to be dropped.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        factory: { interfaceId: { entityName: "NotTransferFactory" } },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject(
        factoryRefusal("factory_interface"),
      );
    });

    it("accepts a factory the instrument's admin did not sign", async () => {
      // Who signs a factory is an implementation's own choice — the Token
      // Standard constrains it nowhere — and real bytes differ: Canton Coin's
      // is signed by the DSO, while a Utility Registry transfer exercises the
      // MERCHANT's own preapproval, signed by the merchant. A rule inferred
      // from Canton Coin refused every registry payment on MainNet.
      //
      // What ties the factory to the issuer is `expectedAdmin`, which the
      // ledger holds against the factory's own admin.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        factory: { inputContracts: [{ signatories: ["someone-else::1220other"] }] },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject({ isValid: true });
    });

    it("accepts the real factory", async () => {
      // The same path the refusals above deviate from, so they are known to
      // fail on the rule and not on the fixture.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture();
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject({ isValid: true });
    });

    it("accepts a factory whose template is not Canton Coin's", async () => {
      // The rule matches the Token Standard INTERFACE, which every registry
      // implements with its own template. Checking Canton Coin's template
      // instead would refuse every other registry's instrument, which this
      // package routes payments to by design.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        factory: {
          templateId: { moduleName: "Other.Registry.Rules", entityName: "OtherRules" },
        },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject({ isValid: true });
    });

    it("accepts an exercise and a disclosure whose package IDS differ", async () => {
      // Canton documents these may differ once a contract has been upgraded or
      // downgraded: the exercise names the package the choice resolved
      // against, the disclosure the one its contract was created under.
      // Requiring them equal would refuse honest payments for the whole window
      // of a Splice rollout.
      const { payload, requirements, payerPublicKeys } = await buildSignedFixture({
        factory: { inputContracts: [{ templateId: { packageId: "a".repeat(64) } }] },
      });
      expect(await verifier.verify(payload, requirements, { payerPublicKeys })).toMatchObject({ isValid: true });
    });
  });

  // Rule 13. The default fixture spends one honest holding for the whole
  // amount (0.01), so each case below changes one thing about it. On Canton
  // Coin it is laid out as a real Amulet is, its amount a whole
  // ExpiringAmount whose round is an Int64.
  describe("the input holdings (Rule 13)", () => {
    const refusal = (payer: string, detail: string) => ({
      isValid: false,
      invalidReason: "invalid_exact_canton_insufficient_inputs",
      payer,
      extensions: { detail },
    });
    const usdx = { id: "USDX", admin: "usdx-issuer::1220issuer" };
    const registry = {
      instrumentId: usdx,
      delivery: {
        choiceId: "TransferRule_DirectTransfer",
        moduleName: "Utility.Registry.V0.Rule.Transfer",
        entityName: "TransferRule",
      },
    };
    const verifyWith = async (overrides: Parameters<typeof buildSignedFixture>[0]) => {
      const { payload, requirements, payer, payerPublicKeys } = await buildSignedFixture(overrides);
      return { payer, result: await verifier.verify(payload, requirements, { payerPublicKeys }) };
    };

    it("refuses a transfer that declares no inputs", async () => {
      // It spends nothing, so it pays with nothing, and fails at the ledger.
      const { payer, result } = await verifyWith({ holdings: [] });
      expect(result).toEqual(refusal(payer, "inputs_none"));
    });

    it("reads an inputHoldingCids holding anything but contract ids as none, rather than skipping", async () => {
      // An honest, disclosed holding beside a Party. A decoder that skipped the
      // bad element would read the holding alone and answer valid.
      const { payer } = await buildSignedFixture();
      const { result } = await verifyWith({
        rawInputHoldingCids: damlValue.list([
          damlValue.contractId(holdingCid(0)),
          damlValue.party(payer),
        ]),
      });
      expect(result).toEqual(refusal(payer, "inputs_none"));
      // The control: the same list without the Party.
      const honest = await verifyWith({
        rawInputHoldingCids: damlValue.list([damlValue.contractId(holdingCid(0))]),
      });
      expect(honest.result).toEqual(verified(payer));
    });

    it("refuses a holding declared twice", async () => {
      // Counted twice, half the amount would cover all of it.
      const { payer, result } = await verifyWith({
        holdings: [{ amount: "0.005" }],
        declaredInputs: [holdingCid(0), holdingCid(0)],
      });
      expect(result).toEqual(refusal(payer, "inputs_repeated"));
    });

    it("refuses an input the transaction does not disclose", async () => {
      const { payer, result } = await verifyWith({ holdings: [{ omitDisclosure: true }] });
      expect(result).toEqual(refusal(payer, "inputs_unresolved"));
    });

    it("refuses an input that names no contract, though a disclosure is as blank", async () => {
      // An absent id decodes as "", as an exercise's does, so it must match
      // nothing rather than a disclosure that is equally blank.
      const { payer, result } = await verifyWith({ holdings: [{ contractId: "" }] });
      expect(result).toEqual(refusal(payer, "inputs_unresolved"));
    });

    it("refuses an undisclosed input even when the others cover the amount", async () => {
      // Rule 13: a declared input that is not an input contract is rejected,
      // never skipped.
      const { payer, result } = await verifyWith({ holdings: [{}, { omitDisclosure: true }] });
      expect(result).toEqual(refusal(payer, "inputs_unresolved"));
    });

    it("refuses an input disclosed twice under one id", async () => {
      // Which of the two is spent is not decidable, as with the factory.
      const { payer, result } = await verifyWith({
        holdings: [{}, { contractId: holdingCid(0) }],
        declaredInputs: [holdingCid(0)],
      });
      expect(result).toEqual(refusal(payer, "inputs_unresolved"));
    });

    it("refuses an input that is not a holding", async () => {
      // The factory is an input contract too, so resolving is not enough.
      const { payer, result } = await verifyWith({ holdings: [], declaredInputs: [EXERCISED_CID] });
      expect(result).toEqual(refusal(payer, "inputs_template"));
    });

    it("refuses a holding of another template, by module or by entity", async () => {
      // A LockedAmulet is refused as Rule 13 names the plain Amulet, even when
      // its lock has expired.
      for (const holding of [{ entityName: "LockedAmulet" }, { moduleName: "Splice.Wallet" }]) {
        const { payer, result } = await verifyWith({ holdings: [holding] });
        expect(result).toEqual(refusal(payer, "inputs_template"));
      }
    });

    it("chooses the holding by the instrument, so neither arm takes the other's", async () => {
      const onAmulet = await verifyWith({
        holdings: [{ moduleName: "Utility.Registry.Holding.V0.Holding", entityName: "Holding" }],
      });
      expect(onAmulet.result).toEqual(refusal(onAmulet.payer, "inputs_template"));
      const onRegistry = await verifyWith({
        ...registry,
        holdings: [{ moduleName: "Splice.Amulet", entityName: "Amulet" }],
      });
      expect(onRegistry.result).toEqual(refusal(onRegistry.payer, "inputs_template"));
    });

    it("refuses a holding not signed by exactly the admin and the sender", async () => {
      // An extra signatory, the admin missing, and someone else's holding
      // signed by them. The first two each pin one direction of the set
      // equality.
      const { payer } = await buildSignedFixture();
      for (const holding of [
        { signatories: ["DSO::1220dso", payer, "extra::1220x"] },
        { signatories: [payer] },
        { owner: "mallory::1220bad", signatories: ["DSO::1220dso", "mallory::1220bad"] },
      ]) {
        const { result } = await verifyWith({ holdings: [holding] });
        expect(result).toEqual(refusal(payer, "inputs_signatories"));
      }
    });

    it("refuses a holding whose owner is not the sender, or is not a Party", async () => {
      const { payer } = await buildSignedFixture();
      const other = await verifyWith({ holdings: [{ owner: "mallory::1220bad" }] });
      expect(other.result).toEqual(refusal(payer, "inputs_owner"));
      // The right party written as Text. A reader that rendered every scalar
      // alike would compare it and pass.
      const asText = await verifyWith({
        holdings: [
          {
            argument: [
              { label: "dso", value: damlValue.party("DSO::1220dso") },
              { label: "owner", value: damlValue.text(payer) },
              {
                label: "amount",
                value: damlValue.record([
                  { label: "initialAmount", value: damlValue.numeric("0.01") },
                ]),
              },
            ],
          },
        ],
      });
      expect(asText.result).toEqual(refusal(payer, "inputs_owner"));
    });

    it("binds a holding's fields the way the engine does", async () => {
      const { payer } = await buildSignedFixture();
      const dso = { label: "dso", value: damlValue.party("DSO::1220dso") };
      const owner = { label: "owner", value: damlValue.party(payer) };
      const amount = {
        label: "amount",
        value: damlValue.record([{ label: "initialAmount", value: damlValue.numeric("0.01") }]),
      };
      // One blank label puts the record in declaration order. A reader that
      // looked labels up regardless would pass this, where `owner` sits at
      // the index declared for `amount`.
      const misplaced = await verifyWith({
        holdings: [
          { argument: [dso, amount, owner, { label: "", value: damlValue.party(payer) }] },
        ],
      });
      expect(misplaced.result).toEqual(refusal(payer, "inputs_owner"));
      // And the blank label is read by position, where a lookup by label
      // would find no owner.
      const positional = await verifyWith({
        holdings: [{ argument: [dso, { ...owner, label: "" }, amount] }],
      });
      expect(positional.result).toEqual(verified(payer));
    });

    it("reads a holding with no labels at all by declaration order, on either arm", async () => {
      // Every field, nested ones included, is then found at its index alone.
      const amulet = await verifyWith({ holdings: [{ positional: true }] });
      expect(amulet.result).toEqual(verified(amulet.payer));
      const onRegistry = await verifyWith({ ...registry, holdings: [{ positional: true }] });
      expect(onRegistry.result).toEqual(verified(onRegistry.payer));
    });

    it("refuses a holding under another admin, on either arm", async () => {
      // The signatories stay right, so only the record's dso or registrar differs.
      const amulet = await verifyWith({ holdings: [{ admin: "other-dso::1220other" }] });
      expect(amulet.result).toEqual(refusal(amulet.payer, "inputs_admin"));
      const onRegistry = await verifyWith({
        ...registry,
        holdings: [{ admin: "other-registrar::1220other" }],
      });
      expect(onRegistry.result).toEqual(refusal(onRegistry.payer, "inputs_admin"));
    });

    it("refuses a registry holding of another instrument", async () => {
      const { payer, result } = await verifyWith({
        ...registry,
        holdings: [{ instrumentId: "OTHER" }],
      });
      expect(result).toEqual(refusal(payer, "inputs_instrument"));
    });

    it("refuses a registry holding whose instrument.id is not Text", async () => {
      // The quoted id written as a Party. A reader that took any scalar would
      // compare it and pass.
      const { payer } = await buildSignedFixture();
      const holding = (id: Uint8Array) => ({
        argument: [
          { label: "operator", value: damlValue.party("operator::1220op") },
          { label: "provider", value: damlValue.party("provider::1220pv") },
          { label: "registrar", value: damlValue.party(usdx.admin) },
          { label: "owner", value: damlValue.party(payer) },
          {
            label: "instrument",
            value: damlValue.record([
              { label: "source", value: damlValue.party(usdx.admin) },
              { label: "id", value: id },
              { label: "scheme", value: damlValue.text("RegistrarInternalScheme") },
            ]),
          },
          { label: "label", value: damlValue.text("") },
          { label: "amount", value: damlValue.numeric("0.01") },
        ],
      });
      const asParty = await verifyWith({
        ...registry,
        holdings: [holding(damlValue.party(usdx.id))],
      });
      expect(asParty.result).toEqual(refusal(payer, "inputs_instrument"));
      // The control: the same record with the id as Text.
      const asText = await verifyWith({ ...registry, holdings: [holding(damlValue.text(usdx.id))] });
      expect(asText.result).toEqual(verified(payer));
    });

    it("refuses an amount that is not a ledger amount", async () => {
      // More precision than the ledger holds, a negative amount, and an amount
      // written as Text.
      const { payer } = await buildSignedFixture();
      for (const holding of [
        { amount: "0.01000000001" },
        { amount: "-1.0" },
        {
          argument: [
            { label: "dso", value: damlValue.party("DSO::1220dso") },
            { label: "owner", value: damlValue.party(payer) },
            {
              label: "amount",
              value: damlValue.record([{ label: "initialAmount", value: damlValue.text("0.01") }]),
            },
          ],
        },
      ]) {
        const { result } = await verifyWith({ holdings: [holding] });
        expect(result).toEqual(refusal(payer, "inputs_amount"));
      }
    });

    it("accepts inputs that sum to exactly the amount, however they are spelled", async () => {
      for (const holdings of [
        [{ amount: "0.0100000000" }],
        [{ amount: "0.004" }, { amount: "0.006" }],
      ]) {
        const { payer, result } = await verifyWith({ holdings });
        expect(result).toEqual(verified(payer));
      }
    });

    it("sums the inputs exactly, past what a float holds", async () => {
      // About 2e19 atomic units, far beyond 2^53. Added as floats, in atomic
      // units or in CC, these two fall one step short of the amount they sum
      // to exactly.
      const holdings = [{ amount: "1000000000.0000000001" }, { amount: "1000000000.009" }];
      const exact = await verifyWith({ amount: "20000000000090000001", holdings });
      expect(exact.result).toEqual(verified(exact.payer));
      const short = await verifyWith({ amount: "20000000000090000002", holdings });
      expect(short.result).toEqual(refusal(short.payer, "inputs_short"));
    });

    it("refuses inputs short of the amount by one atomic unit", async () => {
      for (const holdings of [
        [{ amount: "0.0099999999" }],
        [{ amount: "0.004" }, { amount: "0.0059999999" }],
      ]) {
        const { payer, result } = await verifyWith({ holdings });
        expect(result).toEqual(refusal(payer, "inputs_short"));
      }
    });

    it("accepts a registry holding that covers the amount, and refuses one that does not", async () => {
      const honest = await verifyWith({ ...registry, holdings: [{}] });
      expect(honest.result).toEqual(verified(honest.payer));
      const short = await verifyWith({ ...registry, holdings: [{ amount: "0.005" }] });
      expect(short.result).toEqual(refusal(short.payer, "inputs_short"));
    });

    it("answers an expired transfer as expired, whatever it spends", async () => {
      // Step 18 runs after the deadline, in the spec's order.
      const { payer, result } = await verifyWith({ executeBeforeSeconds: 1, holdings: [] });
      expect(result).toEqual({
        isValid: false,
        invalidReason: "invalid_exact_canton_expired",
        payer,
      });
    });

    it("answers a wrong amount as amount_mismatch, whatever it spends", async () => {
      // And after the binding to the quote, whose amount and instrument it reads.
      const { payload, requirements, payer, payerPublicKeys } = await buildSignedFixture({
        holdings: [],
      });
      expect(
        await verifier.verify(
          payload,
          { ...requirements, amount: "100000001" },
          { payerPublicKeys },
        ),
      ).toEqual({
        isValid: false,
        invalidReason: "invalid_exact_canton_amount_mismatch",
        payer,
        extensions: { detail: "amount" },
      });
    });
  });
});

describe("the registry infrastructure parties (spec Rule 7)", () => {
  const verifier = createCantonExactVerifier(NETWORK);
  const usdx = { id: "USDX", admin: "usdx-issuer::1220issuer" };
  const stranger = "stranger::1220stranger";
  /** What the fixture's rule and holdings name, trusted for the fixture's registrar. */
  const trusted = { [usdx.admin]: [REGISTRY_OPERATOR, REGISTRY_PROVIDER] };
  const refusal = (payer: string, detail: string) => ({
    isValid: false,
    invalidReason: "invalid_exact_canton_preapproval_missing",
    payer,
    extensions: { detail },
  });
  const verifyWith = async (
    overrides: Parameters<typeof buildSignedFixture>[0],
    registryParties?: unknown,
  ) => {
    const { payload, requirements, payer, payerPublicKeys } = await buildSignedFixture({
      instrumentId: usdx,
      delivery: REGISTRY_RULE_TEMPLATE,
      ...overrides,
    });
    const context = (
      registryParties === undefined ? { payerPublicKeys } : { payerPublicKeys, registryParties }
    ) as CantonVerifyContext;
    return { payer, result: await verifier.verify(payload, requirements, context) };
  };

  it("does not run when the caller configures no registry parties, as before it existed", async () => {
    // Every caller written before the field verifies exactly as it did: a rule
    // naming a party nobody configured still passes.
    const { payer, result } = await verifyWith({
      delivery: { ...REGISTRY_RULE_TEMPLATE, operator: stranger },
    });
    expect(result).toEqual(verified(payer));
  });

  it("does not run when the caller passes registryParties as undefined, as a forwarded unset config does", async () => {
    // `registryParties: config.registryParties` with nothing configured. Only
    // a value the caller actually set opts in.
    const { payload, requirements, payer, payerPublicKeys } = await buildSignedFixture({
      instrumentId: usdx,
      delivery: { ...REGISTRY_RULE_TEMPLATE, operator: stranger },
    });
    const context: CantonVerifyContext = { payerPublicKeys, registryParties: undefined };
    expect(await verifier.verify(payload, requirements, context)).toEqual(verified(payer));
  });

  it("accepts a registry payment relying only on parties trusted for its registrar", async () => {
    const { payer, result } = await verifyWith({}, trusted);
    expect(result).toEqual(verified(payer));
  });

  it("refuses a registry token whose registrar the caller configured nobody for", async () => {
    // Opting in makes the map authoritative: an absent registrar fails closed.
    const { payer, result } = await verifyWith({}, {});
    expect(result).toEqual(refusal(payer, "delivery_registry_unconfigured"));
  });

  it("does not let another registrar's entry stand in for this one", async () => {
    const { payer, result } = await verifyWith(
      {},
      { "other-issuer::1220other": [REGISTRY_OPERATOR, REGISTRY_PROVIDER] },
    );
    expect(result).toEqual(refusal(payer, "delivery_registry_unconfigured"));
  });

  it("refuses a rule co-signed by a party nobody configured", async () => {
    const { payer, result } = await verifyWith(
      {
        delivery: {
          ...REGISTRY_RULE_TEMPLATE,
          signatories: [REGISTRY_PROVIDER, usdx.admin, stranger],
        },
      },
      trusted,
    );
    expect(result).toEqual(refusal(payer, "delivery_registry_untrusted"));
  });

  it("refuses a rule whose operator nobody configured, though the operator never signs it", async () => {
    // The captured rule is signed by its provider and the registrar only, so
    // the signatories alone would never show the operator.
    const { payer, result } = await verifyWith(
      { delivery: { ...REGISTRY_RULE_TEMPLATE, operator: stranger } },
      trusted,
    );
    expect(result).toEqual(refusal(payer, "delivery_registry_untrusted"));
  });

  it("refuses a rule whose provider nobody configured, even when its signatories are trusted", async () => {
    const { payer, result } = await verifyWith(
      {
        delivery: {
          ...REGISTRY_RULE_TEMPLATE,
          provider: stranger,
          signatories: [REGISTRY_PROVIDER, usdx.admin],
        },
      },
      trusted,
    );
    expect(result).toEqual(refusal(payer, "delivery_registry_untrusted"));
  });

  it("refuses an input holding whose operator nobody configured", async () => {
    // Answered as Rule 7, not as insufficient inputs: the holding pays, it is
    // the party it names that is untrusted.
    const { payer, result } = await verifyWith({ holdings: [{ operator: stranger }] }, trusted);
    expect(result).toEqual(refusal(payer, "delivery_registry_untrusted"));
  });

  it("refuses an input holding whose provider nobody configured", async () => {
    const { payer, result } = await verifyWith(
      { holdings: [{}, { provider: stranger, amount: "0" }] },
      trusted,
    );
    expect(result).toEqual(refusal(payer, "delivery_registry_untrusted"));
  });

  it("compares the parties as a set, not by role", async () => {
    // The configuration says who is trusted, not which field each one fills.
    const { payer, result } = await verifyWith(
      {
        delivery: {
          ...REGISTRY_RULE_TEMPLATE,
          operator: REGISTRY_PROVIDER,
          provider: REGISTRY_OPERATOR,
          signatories: [REGISTRY_OPERATOR, usdx.admin],
        },
        holdings: [{ operator: REGISTRY_PROVIDER, provider: REGISTRY_OPERATOR }],
      },
      trusted,
    );
    expect(result).toEqual(verified(payer));
  });

  it("trusts the registrar itself in any role, as cBTC's holdings name it their provider", async () => {
    const { payer, result } = await verifyWith(
      { holdings: [{ provider: usdx.admin }] },
      { [usdx.admin]: [REGISTRY_OPERATOR, REGISTRY_PROVIDER] },
    );
    expect(result).toEqual(verified(payer));
  });

  it("reads an empty list as trusting the registrar alone, not as no entry", async () => {
    const alone = { operator: usdx.admin, provider: usdx.admin };
    const { payer, result } = await verifyWith(
      {
        delivery: { ...REGISTRY_RULE_TEMPLATE, ...alone, signatories: [usdx.admin] },
        holdings: [alone],
      },
      { [usdx.admin]: [] },
    );
    expect(result).toEqual(verified(payer));
    // The same list refuses a payment that names anyone else.
    const named = await verifyWith({}, { [usdx.admin]: [] });
    expect(named.result).toEqual(refusal(named.payer, "delivery_registry_untrusted"));
  });

  it("reads the rule's parties at their declared positions when its record is unlabeled", async () => {
    // The fields under test carry no label, so only their position says which
    // is which, as the engine binds them: `operator` and `provider` are
    // fields 0 and 1. A reader that looked them up by label would find neither.
    const unlabeled = ["operator", "provider"];
    const honest = await verifyWith(
      { delivery: { ...REGISTRY_RULE_TEMPLATE, blankDisclosureLabels: unlabeled } },
      trusted,
    );
    expect(honest.result).toEqual(verified(honest.payer));
    const forged = await verifyWith(
      {
        delivery: {
          ...REGISTRY_RULE_TEMPLATE,
          operator: stranger,
          blankDisclosureLabels: unlabeled,
        },
      },
      trusted,
    );
    expect(forged.result).toEqual(refusal(forged.payer, "delivery_registry_untrusted"));
  });

  it("refuses a rule whose operator it cannot find, rather than skipping it", async () => {
    // A party the reader cannot find is not one it trusts. Labelled, the
    // record has no `operator` at all; positional (one label blank), field 0
    // carries a label that contradicts the one declared there. Each label
    // appears once, so the record itself still decodes.
    for (const delivery of [
      { ...REGISTRY_RULE_TEMPLATE, relabelDisclosure: { operator: "custodian" } },
      {
        ...REGISTRY_RULE_TEMPLATE,
        relabelDisclosure: { operator: "custodian" },
        blankDisclosureLabels: ["registrar"],
      },
    ]) {
      const { payer, result } = await verifyWith({ delivery }, trusted);
      expect(result).toEqual(refusal(payer, "delivery_registry_untrusted"));
    }
  });

  it("refuses a holding whose operator is missing, or is not a Party", async () => {
    // inputsViolation never reads these fields, so it would pass both.
    const { payer } = await buildSignedFixture();
    const holding = (operator: { label: string; value: Uint8Array }[]) => ({
      argument: [
        ...operator,
        { label: "provider", value: damlValue.party(REGISTRY_PROVIDER) },
        { label: "registrar", value: damlValue.party(usdx.admin) },
        { label: "owner", value: damlValue.party(payer) },
        {
          label: "instrument",
          value: damlValue.record([
            { label: "source", value: damlValue.party(usdx.admin) },
            { label: "id", value: damlValue.text(usdx.id) },
            { label: "scheme", value: damlValue.text("RegistrarInternalScheme") },
          ]),
        },
        { label: "label", value: damlValue.text("") },
        { label: "amount", value: damlValue.numeric("0.01") },
      ],
    });
    for (const operator of [
      [],
      [{ label: "operator", value: damlValue.text(REGISTRY_OPERATOR) }],
    ]) {
      const { result } = await verifyWith({ holdings: [holding(operator)] }, trusted);
      expect(result).toEqual(refusal(payer, "delivery_registry_untrusted"));
    }
    // The control: the same record with the operator as a Party.
    const honest = await verifyWith(
      { holdings: [holding([{ label: "operator", value: damlValue.party(REGISTRY_OPERATOR) }])] },
      trusted,
    );
    expect(honest.result).toEqual(verified(payer));
  });

  it("leaves an input that does not resolve to the inputs check, which answers it precisely", async () => {
    const { payer, result } = await verifyWith({ holdings: [{ omitDisclosure: true }] }, trusted);
    expect(result).toEqual({
      isValid: false,
      invalidReason: "invalid_exact_canton_insufficient_inputs",
      payer,
      extensions: { detail: "inputs_unresolved" },
    });
  });

  it("leaves an input that is not a registry holding to the inputs check", async () => {
    const { payer, result } = await verifyWith(
      { holdings: [], declaredInputs: [EXERCISED_CID] },
      trusted,
    );
    expect(result).toEqual({
      isValid: false,
      invalidReason: "invalid_exact_canton_insufficient_inputs",
      payer,
      extensions: { detail: "inputs_template" },
    });
  });

  it("is ignored by Canton Coin, configured or not", async () => {
    for (const registryParties of [{}, trusted, "garbage"]) {
      const { payload, requirements, payer, payerPublicKeys } = await buildSignedFixture();
      const context = { payerPublicKeys, registryParties } as unknown as CantonVerifyContext;
      expect(await verifier.verify(payload, requirements, context)).toEqual(verified(payer));
    }
  });

  it("reads a configuration it cannot use as trusting nobody, never as absent", async () => {
    // Present means the caller meant to configure trust; garbage must not
    // switch the check off.
    for (const registryParties of [
      null,
      "garbage",
      [REGISTRY_OPERATOR],
      { [usdx.admin]: REGISTRY_OPERATOR },
      // An inherited entry is not one the caller configured.
      Object.create({ [usdx.admin]: [REGISTRY_OPERATOR, REGISTRY_PROVIDER] }),
    ]) {
      const { payer, result } = await verifyWith({}, registryParties);
      expect(result).toEqual(refusal(payer, "delivery_registry_unconfigured"));
    }
  });

  it("ignores an entry's non-string members rather than refusing the whole entry", async () => {
    const { payer, result } = await verifyWith(
      {},
      { [usdx.admin]: [REGISTRY_OPERATOR, 42, REGISTRY_PROVIDER, null] },
    );
    expect(result).toEqual(verified(payer));
  });
});

describe("the MainNet USDCx capture (spec Rule 7)", () => {
  // A real USDCx transfer, from the x402 project (see __fixtures__/NOTICE).
  // It was never signed and its deadline has passed. Verify takes the payer's
  // keys from the caller, so signing its hash with a throwaway key stands in
  // for the payer's signature, and the clock is pinned inside its deadline.
  const capture = readFileSync(
    new URL("./__fixtures__/mainnet-usdcx-transfer-preapproval.b64", import.meta.url),
    "utf8",
  ).trim();
  const REGISTRAR =
    "decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef";
  const OPERATOR =
    "auth0_007c6643538f2eadd3e573dd05b9::12205bcc106efa0eaa7f18dc491e5c6f5fb9b0cc68dc110ae66f4ed6467475d7c78e";
  const PROVIDER =
    "Bridge-Operator::1220c8448890a70e65f6906bd48d797ee6551f094e9e6a53e329fd5b2b549334f13f";
  const verifier = createCantonExactVerifier(MAINNET_NETWORK);

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Verify the capture as a merchant quoting exactly what it moves would. */
  const verifyCapture = async (registryParties?: Record<string, readonly string[]>) => {
    const transfer = decodePreparedTransaction(capture);
    if (!transfer?.executeBeforeMicros) throw new Error("the USDCx capture no longer decodes");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Number(transfer.executeBeforeMicros / 1000n) - 60_000);

    const seed = new Uint8Array(32).fill(9);
    const preparedTxHash = await computePreparedTransactionHash(capture, HashingSchemeVersion.V2);
    const requirements: CantonPaymentRequirements = {
      scheme: "exact",
      network: MAINNET_NETWORK,
      amount: "10000000", // the transfer's 0.001 USDCx, in atomic units
      asset: "USDCx",
      payTo: transfer.receiver,
      maxTimeoutSeconds: 60,
      extra: {
        assetTransferMethod: "transfer-factory",
        synchronizerId: transfer.synchronizerId as string,
        feePayer: "x402-facilitator::1220fee",
        executeBeforeSeconds: 120,
        instrumentId: transfer.instrumentId,
      },
    };
    const payload: CantonPaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: {
        assetTransferMethod: "transfer-factory",
        preparedTransaction: gzipped(capture),
        preparedTxHash,
        signature: signatureToBase64(signHash(preparedTxHash, toB64(seed))),
        hashingSchemeVersion: HashingSchemeVersion.V2,
      },
    };
    const payerPublicKeys = [toB64(getPublicKey(seed))];
    const context: CantonVerifyContext =
      registryParties === undefined ? { payerPublicKeys } : { payerPublicKeys, registryParties };
    return {
      payer: transfer.sender,
      result: await verifier.verify(payload, requirements, context),
    };
  };
  const refusal = (payer: string, detail: string) => ({
    isValid: false,
    invalidReason: "invalid_exact_canton_preapproval_missing",
    payer,
    extensions: { detail },
  });

  it("passes with its registrar's operator and provider configured", async () => {
    const { payer, result } = await verifyCapture({ [REGISTRAR]: [OPERATOR, PROVIDER] });
    expect(result).toMatchObject({ isValid: true, payer });
  });

  it("passes, as before, when the caller configures no registry parties", async () => {
    const { payer, result } = await verifyCapture();
    expect(result).toMatchObject({ isValid: true, payer });
  });

  it("fails with no entry for its registrar", async () => {
    const { payer, result } = await verifyCapture({});
    expect(result).toEqual(refusal(payer, "delivery_registry_unconfigured"));
  });

  it("fails with either party missing", async () => {
    // The operator never signs the rule; only its field and the holding's name it.
    const noOperator = await verifyCapture({ [REGISTRAR]: [PROVIDER] });
    expect(noOperator.result).toEqual(refusal(noOperator.payer, "delivery_registry_untrusted"));
    // The provider signs the rule and is named by it and by the holding.
    const noProvider = await verifyCapture({ [REGISTRAR]: [OPERATOR] });
    expect(noProvider.result).toEqual(refusal(noProvider.payer, "delivery_registry_untrusted"));
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
    const { payload, requirements, payer, payerPublicKeys } = await buildSignedFixture();
    expect(await registry.verify(payload, requirements, { payerPublicKeys })).toEqual(verified(payer));
  });

  it("answers invalid_network for a registered scheme on a network it does not serve (Rule 1)", async () => {
    const { payload, requirements, payerPublicKeys } = await buildSignedFixture();
    expect(await registry.verify(payload, { ...requirements, network: "canton:testnet" }, { payerPublicKeys })).toEqual({
      isValid: false,
      invalidReason: "invalid_network",
    });
  });

  it("answers unsupported_scheme for a scheme it has no verifier for (Rule 1)", async () => {
    const { payload, requirements, payerPublicKeys } = await buildSignedFixture();
    expect(await registry.verify(payload, { ...requirements, scheme: "upto" }, { payerPublicKeys })).toEqual({
      isValid: false,
      invalidReason: "unsupported_scheme",
    });
  });

  it("routes on the requirements, so a payment whose accepted disagrees reaches the verifier", async () => {
    // Routing never reads the payer's `accepted`: the verifier it reaches gives
    // the specific verdict (Rule 1), rather than a generic no-verifier answer.
    const { payload, requirements, payerPublicKeys } = await buildSignedFixture();
    const p = { ...payload, accepted: { ...payload.accepted, network: "canton:testnet" } };
    expect(await registry.verify(p, requirements, { payerPublicKeys })).toEqual({ isValid: false, invalidReason: "invalid_network" });
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
    const { payload, requirements, payer, payerPublicKeys } = await buildSignedFixture();

    expect(await multi.verify(payload, requirements, { payerPublicKeys })).toEqual(verified(payer));
    const evmReq = { ...requirements, scheme: "exact-evm-to-canton-cc", network: "eip155:1" };
    const evmPayload = { x402Version: 2 as const, accepted: evmReq, payload: {} };
    expect(await multi.verify(evmPayload, evmReq, { payerPublicKeys: [] })).toEqual({ isValid: true, payer: "0xpayer" });
  });
});

describe("the ids the verifier answers to", () => {
  /**
   * The fixture re-pointed at another scheme/network, on both the payload and the
   * requirements, so only the id under test differs from a valid payment.
   */
  async function fixtureFor(scheme: string, network: string) {
    const { payload, requirements, payer, payerPublicKeys } = await buildSignedFixture();
    const req = { ...requirements, scheme, network };
    return {
      payer,
      payerPublicKeys,
      requirements: req,
      payload: { ...payload, accepted: req },
    };
  }

  // Typed to the context this scheme needs, not the bare `SchemeVerifier`
  // whose context defaults to `unknown` — with that, passing the key array
  // where a context belongs type-checks and silently verifies with no keys.
  const verifies = async (
    v: SchemeVerifier<CantonVerifyContext>,
    scheme: string,
    network = NETWORK,
  ) => {
    const f = await fixtureFor(scheme, network);
    return v.verify(f.payload, f.requirements, { payerPublicKeys: f.payerPublicKeys });
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
      invalidReason: "unsupported_scheme",
    });
  });

  it("refuses an unrelated scheme id", async () => {
    expect(await verifies(verifier, "exact-evm-to-canton-cc")).toEqual({
      isValid: false,
      invalidReason: "unsupported_scheme",
    });
  });

  it("refuses a payload and requirements that disagree about the scheme", async () => {
    // Both sides are checked, so naming the right id on one is not enough.
    const { payload, requirements, payerPublicKeys } = await fixtureFor(EXACT_SCHEME_ID, NETWORK);
    expect(
      await verifier.verify({ ...payload, accepted: { ...payload.accepted, scheme: "exact-canton" } }, requirements, { payerPublicKeys }),
    ).toEqual({ isValid: false, invalidReason: "unsupported_scheme" });
  });

  it("refuses requirements naming another scheme, even when the payload is right", async () => {
    // Needs its own case: nothing after the scheme check reads the requirements'
    // scheme (the transfer does not carry it), so checking only the payload side
    // would let this verify.
    const { payload, requirements, payerPublicKeys } = await fixtureFor(EXACT_SCHEME_ID, NETWORK);
    expect(
      await verifier.verify(payload, { ...requirements, scheme: "exact-canton" }, { payerPublicKeys }),
    ).toEqual({ isValid: false, invalidReason: "unsupported_scheme" });
  });

  it("refuses requirements naming another network, even when the payload is right", async () => {
    const { payload, requirements, payerPublicKeys } = await fixtureFor(EXACT_SCHEME_ID, NETWORK);
    expect(
      await verifier.verify(payload, { ...requirements, network: MAINNET_NETWORK }, { payerPublicKeys }),
    ).toEqual({ isValid: false, invalidReason: "invalid_network" });
  });

  it("refuses a network other than the one it is bound to", async () => {
    expect(await verifies(verifier, EXACT_SCHEME_ID, MAINNET_NETWORK)).toEqual({
      isValid: false,
      invalidReason: "invalid_network",
    });
  });

  it("refuses a payload and requirements that disagree about the network", async () => {
    const { payload, requirements, payerPublicKeys } = await fixtureFor(EXACT_SCHEME_ID, NETWORK);
    expect(
      await verifier.verify({ ...payload, accepted: { ...payload.accepted, network: MAINNET_NETWORK } }, requirements, { payerPublicKeys }),
    ).toEqual({ isValid: false, invalidReason: "invalid_network" });
  });
});
