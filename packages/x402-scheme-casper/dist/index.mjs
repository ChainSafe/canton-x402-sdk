// src/types.ts
var EXACT_CASPER_SCHEME_ID = "exact";
var CASPER_MAINNET_NETWORK = "casper:casper";
var CASPER_TESTNET_NETWORK = "casper:casper-test";
function isCasperNetworkId(x) {
  return typeof x === "string" && /^casper:.+/.test(x);
}
function parseCasperNetworkId(s) {
  if (!isCasperNetworkId(s)) throw new Error(`not a casper network id: ${s}`);
  return s;
}
function wcsprAsset(contractHash) {
  return { contractHash, symbol: "wCSPR" };
}

// src/verify.ts
import { isExpired } from "@chainsafe/x402-core";
function isObj(v) {
  return typeof v === "object" && v !== null;
}
var HEX_RE = /^[0-9a-fA-F]+$/;
var DECIMAL_RE = /^\d+$/;
function isCasperPaymentRequirements(v) {
  if (!isObj(v)) return false;
  return (
    typeof v.scheme === "string" &&
    isCasperNetworkId(v.network) &&
    typeof v.maxAmountRequired === "string" &&
    typeof v.payTo === "string" &&
    typeof v.resource === "string" &&
    typeof v.nonce === "string" &&
    typeof v.validBefore === "string" &&
    isObj(v.asset) &&
    typeof v.asset.contractHash === "string"
  );
}
function isCasperPaymentInner(v) {
  if (!isObj(v)) return false;
  const auth = v.authorization;
  return (
    typeof v.signature === "string" &&
    typeof v.publicKey === "string" &&
    isObj(auth) &&
    typeof auth.from === "string" &&
    typeof auth.to === "string" &&
    typeof auth.value === "string" &&
    DECIMAL_RE.test(auth.value) &&
    typeof auth.validAfter === "string" &&
    typeof auth.validBefore === "string" &&
    typeof auth.nonce === "string"
  );
}
function fail(reason, payer) {
  return { isValid: false, invalidReason: reason, ...(payer ? { payer } : {}) };
}
function verifyExactCasper(networkId, payload, requirements) {
  if (payload.scheme !== EXACT_CASPER_SCHEME_ID || requirements.scheme !== EXACT_CASPER_SCHEME_ID) {
    return fail("scheme_mismatch");
  }
  if (payload.network !== requirements.network || payload.network !== networkId) {
    return fail("network_mismatch");
  }
  if (!isCasperPaymentRequirements(requirements) || !isObj(payload.payload)) {
    return fail("internal_error");
  }
  const raw = payload.payload;
  const payer =
    isObj(raw.authorization) && typeof raw.authorization.from === "string"
      ? raw.authorization.from
      : void 0;
  if (typeof raw.publicKey !== "string" || !raw.publicKey || !HEX_RE.test(raw.publicKey)) {
    return fail("missing_public_key", payer);
  }
  if (!isCasperPaymentInner(raw)) return fail("internal_error", payer);
  const inner = raw;
  const auth = inner.authorization;
  const nowSeconds = Math.floor(Date.now() / 1e3);
  if (isExpired(requirements.validBefore)) return fail("requirements_expired", auth.from);
  if (!DECIMAL_RE.test(auth.validBefore) || Number(auth.validBefore) <= nowSeconds) {
    return fail("requirements_expired", auth.from);
  }
  if (DECIMAL_RE.test(auth.validAfter) && Number(auth.validAfter) > nowSeconds) {
    return fail("requirements_expired", auth.from);
  }
  if (auth.to !== requirements.payTo) return fail("requirements_hash_mismatch", auth.from);
  if (BigInt(auth.value) > BigInt(requirements.maxAmountRequired)) {
    return fail("requirements_hash_mismatch", auth.from);
  }
  if (!HEX_RE.test(inner.signature)) return fail("bad_signature", auth.from);
  return { isValid: true, payer: auth.from };
}
function createExactCasperVerifier(networkId) {
  return {
    schemeId: EXACT_CASPER_SCHEME_ID,
    networkId,
    verify: (payload, requirements) => verifyExactCasper(networkId, payload, requirements),
  };
}

// src/facilitator.ts
var DEFAULT_CASPER_FACILITATOR_URL = "https://x402-facilitator.cspr.cloud";
var CasperFacilitatorError = class extends Error {
  constructor(endpoint, status, body, options) {
    super(`casper facilitator ${endpoint} failed (${status || "network error"})`, options);
    this.endpoint = endpoint;
    this.status = status;
    this.body = body;
    this.name = "CasperFacilitatorError";
  }
  endpoint;
  status;
  body;
};
var CasperFacilitatorClient = class {
  /**
   * @param facilitatorUrl Base URL of the facilitator; a trailing slash is
   *   trimmed. Defaults to {@link DEFAULT_CASPER_FACILITATOR_URL}.
   * @param opts Optional API key + request timeout.
   */
  constructor(facilitatorUrl = DEFAULT_CASPER_FACILITATOR_URL, opts = {}) {
    this.opts = opts;
    this.base = facilitatorUrl.replace(/\/$/, "");
  }
  opts;
  base;
  /**
   * POST /verify — dry-run validation without settling. Resolves with the
   * verdict (`isValid` true or false); throws {@link CasperFacilitatorError}
   * only on a protocol/transport error.
   */
  verify(payload, requirements) {
    return this.postDomain("/verify", envelope(payload, requirements));
  }
  /**
   * POST /settle — submit the CEP-18 `transfer_with_authorization` on-chain.
   * Resolves with the outcome (`success` true or false); throws
   * {@link CasperFacilitatorError} only on a protocol/transport error.
   */
  settle(payload, requirements) {
    return this.postDomain("/settle", envelope(payload, requirements));
  }
  async postDomain(path, body) {
    const headers = {
      "Content-Type": "application/json",
      ...(await this.authHeaders()),
    };
    let res;
    try {
      res = await fetch(`${this.base}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: this.opts.timeoutMs ? AbortSignal.timeout(this.opts.timeoutMs) : void 0,
      });
    } catch (cause) {
      throw new CasperFacilitatorError(path, 0, void 0, { cause });
    }
    let text;
    try {
      text = await res.text();
    } catch (cause) {
      throw new CasperFacilitatorError(path, res.status, void 0, { cause });
    }
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : void 0;
    } catch {
      parsed = void 0;
    }
    if (res.ok && parsed !== void 0) return parsed;
    throw new CasperFacilitatorError(path, res.status, parsed ?? text);
  }
  async authHeaders() {
    const { apiKey } = this.opts;
    const resolved = typeof apiKey === "function" ? await apiKey() : apiKey;
    return resolved ? { Authorization: `Bearer ${resolved}` } : {};
  }
};
function envelope(payload, requirements) {
  return {
    x402Version: payload.x402Version,
    paymentPayload: payload,
    paymentRequirements: requirements,
  };
}
export {
  CASPER_MAINNET_NETWORK,
  CASPER_TESTNET_NETWORK,
  CasperFacilitatorClient,
  CasperFacilitatorError,
  DEFAULT_CASPER_FACILITATOR_URL,
  EXACT_CASPER_SCHEME_ID,
  createExactCasperVerifier,
  isCasperNetworkId,
  isCasperPaymentInner,
  isCasperPaymentRequirements,
  parseCasperNetworkId,
  wcsprAsset,
};
//# sourceMappingURL=index.mjs.map
