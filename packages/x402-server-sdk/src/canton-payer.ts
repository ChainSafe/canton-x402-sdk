import {
  ASSET_TRANSFER_METHOD,
  EXACT_SCHEME_ID,
  WIRE_DECIMALS,
  atomicToLedger,
  signHash,
  signatureToBase64,
  gzipPreparedTransaction,
  type CantonPaymentPayload,
  type CantonPaymentRequirements,
  type InstrumentId,
  type NetworkId,
} from "@chainsafe/x402-core";
import type { SDKInterface } from "@canton-network/wallet-sdk";
import type { X402Payer } from "./payer.js";


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
  network: NetworkId;
  /** The assets this payer supports, each with its Token Standard registry. */
  registries: AssetRegistry[];
}

/**
 * Canton canton-exact payer over `@canton-network/wallet-sdk`: builds a Token
 * Standard transfer, prepares it (interactive submission), Ed25519-signs the hash,
 * and assembles the X-PAYMENT payload — without executing (the facilitator settles).
 */
export class CantonX402Payer implements X402Payer {
  constructor(private readonly opts: CantonX402PayerOptions) {}

  supports(requirements: CantonPaymentRequirements): boolean {
    return (
      requirements.scheme === EXACT_SCHEME_ID &&
      requirements.network === this.opts.network &&
      // The payload declares the method this payer uses. createX402Fetch does
      // not validate the 402 body, so the type alone does not guarantee it.
      requirements.extra.assetTransferMethod === ASSET_TRANSFER_METHOD &&
      this.registryFor(requirements.extra.instrumentId) !== undefined
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
    // Capability gate — supports() covers scheme + network + transfer method + a configured registry.
    const registryUrl = this.registryFor(requirements.extra.instrumentId);
    if (!this.supports(requirements) || !registryUrl) {
      const { id, admin } = requirements.extra.instrumentId;
      throw new Error(
        `x402: unsupported requirement (scheme "${requirements.scheme}", network "${requirements.network}", method "${requirements.extra.assetTransferMethod}", asset "${id}" admin "${admin}")`,
      );
    }

    // Per-request validity — not a capability, so checked here rather than in supports().
    // Quoted in atomic units; the wallet SDK builds the transfer in Decimal.
    const ledgerAmount = atomicToLedger(requirements.amount, WIRE_DECIMALS);
    if (ledgerAmount === null) {
      throw new Error(`x402: invalid amount "${requirements.amount}" (expected atomic units)`);
    }
    const { sdk, key } = this.opts;

    // 1. Build the Token Standard transfer (routes the TransferFactory via the registry).
    //    `expirationDate` becomes the transfer's `executeBefore`. Left unset the
    //    wallet SDK picks 24 hours, which the quoted horizon is meant to replace
    //    — and the verifier checks what the transfer carries, not what was quoted.
    //    The memo travels under the scheme's own key: the SDK's `memo` parameter
    //    writes `splice.lfdecentralizedtrust.org/reason`, a different one, so
    //    both can be present without either standing in for the other.
    const [command, disclosed] = await sdk.token.transfer.create({
      sender: key.partyId,
      recipient: requirements.payTo,
      amount: ledgerAmount,
      instrumentId: requirements.extra.instrumentId.id,
      registryUrl,
      expirationDate: new Date(Date.now() + requirements.extra.executeBeforeSeconds * 1000),
      ...(requirements.extra.memo === undefined
        ? {}
        : { meta: { values: { "x402.memo": requirements.extra.memo } } }),
    });

    // 2. Prepare (interactive submission) → prepared tx + hash to sign.
    const { response } = await sdk.ledger
      .prepare({ partyId: key.partyId, commands: command, disclosedContracts: disclosed })
      .toJSON();

    // 3. Sign the hash. wallet-sdk hands the hash as base64; the payload carries it
    //    as hex and the signature as base64, which are the spec's encodings.
    const preparedTxHash = base64ToHex(response.preparedTransactionHash);
    const signature = signatureToBase64(signHash(preparedTxHash, key.privateKey));

    // 4. Assemble the payload the facilitator settles.
    return {
      x402Version: 2,
      scheme: requirements.scheme,
      network: requirements.network,
      payload: {
        // transfer.create built a TransferFactory_Transfer, the one method Canton's
        // exact defines.
        assetTransferMethod: ASSET_TRANSFER_METHOD,
        payer: key.partyId,
        // prepare hands back the protobuf as base64; the payload carries it
        // gzipped, as the spec defines, which also keeps the header small.
        preparedTransaction: gzipPreparedTransaction(Buffer.from(response.preparedTransaction, "base64")),
        preparedTxHash,
        signature,
        publicKey: key.publicKey,
        // Must be exactly what prepare used — the signature is bound to a hash
        // computed with this version, so the facilitator's execute must match it.
        hashingSchemeVersion: response.hashingSchemeVersion,
      },
    };
  }
}

function base64ToHex(b64: string): string {
  return Buffer.from(b64, "base64").toString("hex");
}
