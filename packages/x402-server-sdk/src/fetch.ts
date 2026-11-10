import {
  decodePaymentRequiredHeader,
  encodePaymentHeader,
  type CantonPaymentRequirements,
  type ResourceInfo,
} from "@chainsafe/x402-core";
import type { X402Payer } from "./payer.js";

/** A `fetch`-compatible function. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** A chosen payer paired with the requirement it will satisfy. */
export interface X402Selection {
  payer: X402Payer;
  requirements: CantonPaymentRequirements;
}

export interface X402FetchOptions {
  /**
   * Choose which payer pays which advertised requirement. Default: for each
   * `accepts[]` entry in the server's order, the first payer that `supports()` it —
   * so the server's preference order wins and mixed-scheme offers route correctly.
   */
  select?: (accepts: CantonPaymentRequirements[], payers: X402Payer[]) => X402Selection | undefined;
  /** Underlying fetch to wrap. Defaults to the global `fetch`. */
  fetch?: FetchLike;
}

/**
 * Wrap `fetch` so x402 payments are transparent: call the resource, and on a `402`
 * read the accepted requirements, pay via a matching payer, and retry with the
 * payment in the `PAYMENT-SIGNATURE` header, where the x402 v2 HTTP transport
 * carries it. Non-402 responses — and 402s no payer can satisfy — pass through
 * unchanged.
 *
 * Accepts one payer or several; with several, each advertised requirement routes to
 * the first payer that `supports()` it (e.g. a Canton payer + an EVM payer). Depends
 * only on the {@link X402Payer} contract, so it's scheme-agnostic.
 *
 * Works for any HTTP method. The paid request is **retried**, so a request body must
 * be re-readable (a value like a string / JSON / `Buffer` / `URLSearchParams`, not a
 * `ReadableStream`, and don't pass a `Request` object whose body the first call consumes).
 *
 * @example
 * const f = createX402Fetch(payer);                 // one payer
 * const f = createX402Fetch([cantonPayer, evmPayer]); // several
 * const res = await f("https://api.example/paid");
 */
export function createX402Fetch(payers: X402Payer | X402Payer[], opts: X402FetchOptions = {}): FetchLike {
  const list = Array.isArray(payers) ? payers : [payers];
  const doFetch = opts.fetch ?? fetch;
  const select = opts.select ?? defaultSelect;

  return async (input, init) => {
    const res = await doFetch(input, init);
    if (res.status !== 402) return res;

    const offer = await readPaymentRequired(res);
    if (!offer) return res; // not an x402 402 → pass through

    const selection = select(offer.accepts, list);
    if (!selection) return res; // no payer can satisfy any advertised requirement

    const payload = await selection.payer.authorize(selection.requirements, {
      ...(offer.resource ? { resource: offer.resource } : {}),
    });
    const headers = new Headers(init?.headers);
    headers.set("PAYMENT-SIGNATURE", encodePaymentHeader(payload));
    return doFetch(input, { ...init, headers });
  };
}

/** For each requirement in the server's order, the first payer that supports it. */
function defaultSelect(
  accepts: CantonPaymentRequirements[],
  payers: X402Payer[],
): X402Selection | undefined {
  for (const requirements of accepts) {
    const payer = payers.find((p) => p.supports(requirements));
    if (payer) return { payer, requirements };
  }
  return undefined;
}

/**
 * Read the 402's `PaymentRequired`: the `PAYMENT-REQUIRED` header first, the
 * body only as a fallback.
 *
 * The header is where the x402 v2 HTTP transport puts it, and it calls the
 * response body a server implementation concern — so a conforming merchant may
 * answer `{}`, and every registered Canton merchant does. Reading the body
 * alone meant this wrapper silently declined to pay all of them.
 *
 * The body fallback stays for merchants that send it there, this SDK's own
 * middleware among them. Either way the response is cloned, so the caller's
 * copy is untouched.
 */
async function readPaymentRequired(
  res: Response,
): Promise<{ resource?: ResourceInfo; accepts: CantonPaymentRequirements[] } | undefined> {
  const header = res.headers.get("PAYMENT-REQUIRED");
  if (header) {
    try {
      const offer = decodePaymentRequiredHeader(header);
      return { resource: offer.resource, accepts: offer.accepts };
    } catch {
      // Malformed header; a body may still carry a readable offer.
    }
  }
  try {
    const body = (await res.clone().json()) as { accepts?: unknown; resource?: unknown };
    if (!Array.isArray(body.accepts)) return undefined;
    const accepts = body.accepts as CantonPaymentRequirements[];
    return isResourceInfo(body.resource) ? { resource: body.resource, accepts } : { accepts };
  } catch {
    return undefined;
  }
}

function isResourceInfo(value: unknown): value is ResourceInfo {
  return typeof value === "object" && value !== null && typeof (value as ResourceInfo).url === "string";
}
