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
  FacilitatorClient: () => FacilitatorClient,
  FacilitatorError: () => FacilitatorError,
  VERSION: () => VERSION
});
module.exports = __toCommonJS(index_exports);

// src/facilitator.ts
var FacilitatorError = class extends Error {
  constructor(endpoint, status, body, retryAfter, options) {
    super(`facilitator ${endpoint} failed (${status || "network error"})`, options);
    this.endpoint = endpoint;
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
    this.name = "FacilitatorError";
  }
  endpoint;
  status;
  body;
  retryAfter;
};
var FacilitatorClient = class {
  /**
   * @param facilitatorUrl Base URL of the facilitator; a trailing slash is trimmed.
   * @param opts Optional API key + request timeout.
   */
  constructor(facilitatorUrl, opts = {}) {
    this.opts = opts;
    this.base = facilitatorUrl.replace(/\/$/, "");
  }
  opts;
  base;
  /**
   * POST /v2/verify — dry-run validation without settling. Resolves with the
   * verdict (`isValid` true or false); throws {@link FacilitatorError} only on a
   * protocol/transport error.
   */
  verify(payload, requirements) {
    return this.postDomain("/v2/verify", envelope(payload, requirements));
  }
  /**
   * POST /v2/settle — execute the prepared transfer on-ledger. Resolves with the
   * outcome (`success` true or false); throws {@link FacilitatorError} only on a
   * protocol/transport error.
   */
  settle(payload, requirements) {
    return this.postDomain("/v2/settle", envelope(payload, requirements));
  }
  /** GET /v2/supported — the (scheme, network) kinds this facilitator accepts. Unauthenticated. */
  async supported() {
    const res = await this.request("/v2/supported", "GET", void 0, false);
    if (res.ok && res.parsed !== void 0) return res.parsed;
    throw this.error("/v2/supported", res);
  }
  /**
   * Shared POST path for verify/settle: send the envelope and return the domain
   * response on 2xx, or throw {@link FacilitatorError} on anything else.
   */
  async postDomain(path, body) {
    const res = await this.request(path, "POST", JSON.stringify(body));
    if (res.ok && res.parsed !== void 0) return res.parsed;
    throw this.error(path, res);
  }
  /**
   * Perform one HTTP request and normalize the result into a {@link RawResponse}.
   * Every failure mode — no response, a failed body read — is converted into a
   * {@link FacilitatorError}, so callers never see a raw fetch rejection.
   */
  async request(path, method, jsonBody, sendAuth = true) {
    const headers = sendAuth ? await this.authHeaders() : {};
    if (jsonBody !== void 0) headers["Content-Type"] = "application/json";
    let res;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: jsonBody,
        signal: this.opts.timeoutMs ? AbortSignal.timeout(this.opts.timeoutMs) : void 0
      });
    } catch (cause) {
      throw new FacilitatorError(path, 0, void 0, void 0, { cause });
    }
    let text;
    try {
      text = await res.text();
    } catch (cause) {
      throw new FacilitatorError(path, res.status, void 0, void 0, { cause });
    }
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : void 0;
    } catch {
      parsed = void 0;
    }
    return {
      ok: res.ok,
      status: res.status,
      parsed,
      text,
      retryAfter: parseRetryAfter(res.headers.get("retry-after"))
    };
  }
  /** Build a {@link FacilitatorError} from a non-domain response (parsed body preferred over raw text). */
  error(path, res) {
    return new FacilitatorError(path, res.status, res.parsed ?? res.text, res.retryAfter);
  }
  /** Resolve the configured API key (static or async) into an `Authorization` header, if any. */
  async authHeaders() {
    const { apiKey } = this.opts;
    const resolved = typeof apiKey === "function" ? await apiKey() : apiKey;
    return resolved ? { Authorization: `Bearer ${resolved}` } : {};
  }
};
function parseRetryAfter(value) {
  if (!value) return void 0;
  if (/^\d+$/.test(value)) return Number(value);
  const when = Date.parse(value);
  return Number.isNaN(when) ? void 0 : Math.max(0, Math.round((when - Date.now()) / 1e3));
}
function envelope(payload, requirements) {
  return {
    x402Version: payload.x402Version,
    paymentPayload: payload,
    paymentRequirements: requirements
  };
}

// src/index.ts
var VERSION = "0.0.1";
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FacilitatorClient,
  FacilitatorError,
  VERSION
});
//# sourceMappingURL=index.cjs.map