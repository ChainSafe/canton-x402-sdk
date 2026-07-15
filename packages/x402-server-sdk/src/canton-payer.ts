import {
  fingerprintForPublicKey,
  isExpired,
  isValidAmount,
  requirementsHash,
  signHash,
  type CantonPaymentPayload,
  type CantonPaymentRequirements,
  type DisclosedContract,
  type HashingSchemeVersion,
  type InstrumentId,
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
  /** Base64 32-byte Ed25519 seed (private). */
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
  network: string;
  /** The assets this payer supports, each with its Token Standard registry. */
  registries: AssetRegistry[];
  /** Override the hashing scheme (defaults to what prepare returns). */
  hashingSchemeVersion?: HashingSchemeVersion;
}

/**
 * Canton exact-canton payer over `@canton-network/wallet-sdk`: builds a Token
 * Standard transfer, prepares it (interactive submission), Ed25519-signs the hash,
 * and assembles the X-PAYMENT payload — without executing (the facilitator settles).
 */
export class CantonX402Payer implements X402Payer {
  constructor(private readonly opts: CantonX402PayerOptions) {}

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
    if (requirements.scheme !== EXACT_CANTON) {
      throw new Error(`x402: unsupported scheme "${requirements.scheme}"`);
    }
    if (requirements.network !== this.opts.network) {
      throw new Error(`x402: requirement network "${requirements.network}" != payer network "${this.opts.network}"`);
    }
    const registryUrl = this.registryFor(requirements.asset.instrumentId);
    if (!registryUrl) {
      throw new Error(
        `x402: no registry configured for asset "${requirements.asset.instrumentId.id}" (admin ${requirements.asset.instrumentId.admin})`,
      );
    }
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
    const partySignature = signHash(preparedTransactionHash, key.privateKey);

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
        keyFingerprint: fingerprintForPublicKey(key.publicKey),
        disclosedContracts: disclosed.map(toDisclosedContract),
        requirementsHash: requirementsHash(requirements),
        publicKey: key.publicKey,
        hashingSchemeVersion: this.opts.hashingSchemeVersion ?? response.hashingSchemeVersion,
      },
    };
  }
}

function toDisclosedContract(d: {
  templateId?: string;
  contractId?: string;
  createdEventBlob: string;
  synchronizerId?: string;
}): DisclosedContract {
  return {
    templateId: d.templateId ?? "",
    contractId: d.contractId ?? "",
    createdEventBlob: d.createdEventBlob,
    synchronizerId: d.synchronizerId ?? "",
  };
}

function base64ToHex(b64: string): string {
  return Buffer.from(b64, "base64").toString("hex");
}
