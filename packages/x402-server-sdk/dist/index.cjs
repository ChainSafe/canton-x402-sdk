"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  CantonX402Payer: () => CantonX402Payer,
  FacilitatorClient: () => import_x402_client.FacilitatorClient,
  FacilitatorError: () => import_x402_client.FacilitatorError,
  VERSION: () => VERSION,
  createX402Fetch: () => createX402Fetch,
  devnetConfig: () => devnetConfig,
  localnetConfig: () => localnetConfig,
  mainnetConfig: () => mainnetConfig
});
module.exports = __toCommonJS(index_exports);

// src/fetch.ts
var import_x402_core = require("@chainsafe/x402-core");
function createX402Fetch(payers, opts = {}) {
  const list = Array.isArray(payers) ? payers : [payers];
  const doFetch = opts.fetch ?? fetch;
  const select = opts.select ?? defaultSelect;
  return async (input, init) => {
    const res = await doFetch(input, init);
    if (res.status !== 402) return res;
    const accepts = await readAccepts(res);
    if (!accepts) return res;
    const selection = select(accepts, list);
    if (!selection) return res;
    const payload = await selection.payer.authorize(selection.requirements);
    const headers = new Headers(init?.headers);
    headers.set("X-PAYMENT", (0, import_x402_core.encodePaymentHeader)(payload, selection.requirements));
    return doFetch(input, { ...init, headers });
  };
}
function defaultSelect(accepts, payers) {
  for (const requirements of accepts) {
    const payer = payers.find((p) => p.supports(requirements));
    if (payer) return { payer, requirements };
  }
  return void 0;
}
async function readAccepts(res) {
  try {
    const body = await res.clone().json();
    return Array.isArray(body.accepts) ? body.accepts : void 0;
  } catch {
    return void 0;
  }
}

// src/canton-payer.ts
var import_x402_core2 = require("@chainsafe/x402-core");
var EXACT_CANTON = "exact-canton";
var CantonX402Payer = class {
  constructor(opts) {
    this.opts = opts;
  }
  opts;
  supports(requirements) {
    return requirements.scheme === EXACT_CANTON && requirements.network === this.opts.network && this.registryFor(requirements.asset.instrumentId) !== void 0;
  }
  /** Registry URL for a supported asset, or `undefined` if this payer doesn't carry it. */
  registryFor(instrumentId) {
    const match = this.opts.registries.find(
      (r) => r.instrumentId.id === instrumentId.id && r.instrumentId.admin === instrumentId.admin
    );
    return match ? new URL(match.registryUrl.toString()) : void 0;
  }
  async authorize(requirements) {
    const registryUrl = this.registryFor(requirements.asset.instrumentId);
    if (!this.supports(requirements) || !registryUrl) {
      const { id, admin } = requirements.asset.instrumentId;
      throw new Error(
        `x402: unsupported requirement (scheme "${requirements.scheme}", network "${requirements.network}", asset "${id}" admin "${admin}")`
      );
    }
    if (!(0, import_x402_core2.isValidAmount)(requirements.maxAmountRequired)) {
      throw new Error(`x402: invalid amount "${requirements.maxAmountRequired}"`);
    }
    if ((0, import_x402_core2.isExpired)(requirements.validBefore)) {
      throw new Error(`x402: requirements expired at ${requirements.validBefore}`);
    }
    const { sdk, key } = this.opts;
    const [command, disclosed] = await sdk.token.transfer.create({
      sender: key.partyId,
      recipient: requirements.payTo,
      amount: requirements.maxAmountRequired,
      instrumentId: requirements.asset.instrumentId.id,
      registryUrl
    });
    const { response } = await sdk.ledger.prepare({ partyId: key.partyId, commands: command, disclosedContracts: disclosed }).toJSON();
    const preparedTransactionHash = base64ToHex(response.preparedTransactionHash);
    const partySignature = (0, import_x402_core2.signHash)(preparedTransactionHash, key.privateKey);
    return {
      x402Version: 2,
      scheme: requirements.scheme,
      network: requirements.network,
      payload: {
        payer: key.partyId,
        preparedTransaction: response.preparedTransaction,
        preparedTransactionHash,
        partySignature,
        requirementsHash: (0, import_x402_core2.requirementsHash)(requirements),
        publicKey: key.publicKey,
        // Must be exactly what prepare used — the signature is bound to a hash
        // computed with this version, so the facilitator's execute must match it.
        hashingSchemeVersion: response.hashingSchemeVersion
      }
    };
  }
};
function base64ToHex(b64) {
  return Buffer.from(b64, "base64").toString("hex");
}

// src/canton-config.ts
var import_x402_core3 = require("@chainsafe/x402-core");
var CN_AUDIENCE = "https://canton.network.global";
function localnetConfig(opts) {
  return {
    network: opts.network,
    ledgerClientUrl: opts.ledgerClientUrl ?? "http://localhost:2975",
    auth: opts.auth ?? { audience: CN_AUDIENCE, scope: "", issuer: "unsafe-auth" }
  };
}
function devnetConfig(opts) {
  return {
    network: opts.network ?? import_x402_core3.DEVNET_NETWORK,
    ledgerClientUrl: opts.ledgerClientUrl,
    auth: opts.auth ?? { audience: CN_AUDIENCE, scope: "" }
  };
}
function mainnetConfig(opts) {
  return {
    network: opts.network ?? import_x402_core3.MAINNET_NETWORK,
    ledgerClientUrl: opts.ledgerClientUrl,
    auth: opts.auth ?? { audience: CN_AUDIENCE, scope: "" }
  };
}

// src/index.ts
var import_x402_client = require("@chainsafe/x402-client");
var VERSION = "0.0.1";
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CantonX402Payer,
  FacilitatorClient,
  FacilitatorError,
  VERSION,
  createX402Fetch,
  devnetConfig,
  localnetConfig,
  mainnetConfig
});
//# sourceMappingURL=index.cjs.map