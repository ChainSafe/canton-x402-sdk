import {
  isExpired,
  isValidAmount,
  requirementsHash,
  signHash,
  type CantonPaymentPayload,
  type CantonPaymentRequirements,
  type InstrumentId,
  type NetworkId,
} from "@chainsafe/x402-core";
import type { SDKInterface } from "@canton-network/wallet-sdk";
import type { X402Payer } from "./payer.js";

const EXACT_CANTON = "exact-canton";

/** The external party's Ed25519 key material (client-side only). */
export interface CantonPartyKey {
  /** Party ID: `<hint>::<fingerprint>`. */
  partyId: string;
  /** Base64 32-byte Ed25519 public key. */
  publicKey: string;
  /**
   * Base64 Ed25519 private key: the 32-byte seed, or the 64-byte nacl/libsodium
   * secret key (`seed || publicKey`) that wallet-sdk key generation returns.
   */
  privateKey: string;
}

/** A supported asset and the Token Standard registry that routes its transfer factory. */
export interface AssetRegistry {
  instrumentId: InstrumentId;
  registryUrl: string | URL;
}

export interface CantonX402PayerOptions {
  /** A wallet-sdk instance with the token namespace (built via `SDK.create({ ..., token })`). */
  sdk: SDKInterface<"token">;
  /** The paying party's Ed25519 key. */
  key: CantonPartyKey;
  /** The network id this payer's `sdk` is connected to (rejects requirements for others). */
  network: NetworkId;
  /** The assets this payer supports, each with its Token Standard registry. */
  registries: AssetRegistry[];
}

/**
 * Canton exact-canton payer over `@canton-network/wallet-sdk`: builds a Token
 * Standard transfer, prepares it (interactive submission), Ed25519-signs the hash,
 * and assembles the X-PAYMENT payload — without executing (the facilitator settles).
 */
export class CantonX402Payer implements X402Payer {
  /** The key's base64 32-byte seed, validated up front so a bad key fails here, not mid-payment. */
  private readonly seed: string;

  constructor(private readonly opts: CantonX402PayerOptions) {
    this.seed = toSeed(opts.key);
  }

  supports(requirements: CantonPaymentRequirements): boolean {
    return (
      requirements.scheme === EXACT_CANTON &&
      requirements.network === this.opts.network &&
      this.registryFor(requirements.asset.instrumentId) !== undefined
    );
  }

  /** Registry URL for a supported asset, or `undefined` if this payer doesn't carry it. */
  private registryFor(instrumentId: InstrumentId): URL | undefined {
    const match = this.opts.registries.find(
      (r) => r.instrumentId.id === instrumentId.id && r.instrumentId.admin === instrumentId.admin,
    );
    return match ? new URL(match.registryUrl.toString()) : undefined;
  }

  async authorize(requirements: CantonPaymentRequirements): Promise<CantonPaymentPayload> {
    // Capability gate — supports() covers scheme + network + a configured registry.
    const registryUrl = this.registryFor(requirements.asset.instrumentId);
    if (!this.supports(requirements) || !registryUrl) {
      const { id, admin } = requirements.asset.instrumentId;
      throw new Error(
        `x402: unsupported requirement (scheme "${requirements.scheme}", network "${requirements.network}", asset "${id}" admin "${admin}")`,
      );
    }

    // Per-request validity — not a capability, so checked here rather than in supports().
    if (!isValidAmount(requirements.maxAmountRequired)) {
      throw new Error(`x402: invalid amount "${requirements.maxAmountRequired}"`);
    }
    if (isExpired(requirements.validBefore)) {
      throw new Error(`x402: requirements expired at ${requirements.validBefore}`);
    }

    const { sdk, key } = this.opts;

    // 1. Build the Token Standard transfer (routes the TransferFactory via the registry).
    const [command, disclosed] = await sdk.token.transfer.create({
      sender: key.partyId,
      recipient: requirements.payTo,
      amount: requirements.maxAmountRequired,
      instrumentId: requirements.asset.instrumentId.id,
      registryUrl,
    });

    // 2. Prepare (interactive submission) → prepared tx + hash to sign.
    const { response } = await sdk.ledger
      .prepare({ partyId: key.partyId, commands: command, disclosedContracts: disclosed })
      .toJSON();

    // 3. Sign the hash. wallet-sdk hands base64; sign the same bytes as hex so the
    //    facilitator's verifySignature (raw Ed25519 over the hash) accepts it.
    const preparedTransactionHash = base64ToHex(response.preparedTransactionHash);
    const partySignature = signHash(preparedTransactionHash, this.seed);

    // 4. Assemble the payload the facilitator settles.
    return {
      x402Version: 2,
      scheme: requirements.scheme,
      network: requirements.network,
      payload: {
        payer: key.partyId,
        preparedTransaction: response.preparedTransaction,
        preparedTransactionHash,
        partySignature,
        requirementsHash: requirementsHash(requirements),
        publicKey: key.publicKey,
        // Must be exactly what prepare used — the signature is bound to a hash
        // computed with this version, so the facilitator's execute must match it.
        hashingSchemeVersion: response.hashingSchemeVersion,
      },
    };
  }
}

/**
 * The base64 32-byte seed `signHash` takes. A 64-byte nacl secret key is
 * `seed || publicKey`, so keep the seed half — after checking the public half is
 * this key's, so a mismatched pair fails here rather than as a bad signature.
 */
function toSeed(key: CantonPartyKey): string {
  const bytes = Buffer.from(key.privateKey, "base64");
  if (bytes.length === 32) return bytes.toString("base64");
  if (bytes.length === 64) {
    if (!bytes.subarray(32).equals(Buffer.from(key.publicKey, "base64"))) {
      throw new Error("x402: 64-byte private key does not embed the configured public key");
    }
    return bytes.subarray(0, 32).toString("base64");
  }
  throw new Error(
    `x402: private key must be a 32-byte seed or 64-byte secret key (got ${bytes.length} bytes)`,
  );
}

function base64ToHex(b64: string): string {
  return Buffer.from(b64, "base64").toString("hex");
}
