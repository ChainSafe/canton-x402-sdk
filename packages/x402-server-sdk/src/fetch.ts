import { encodePaymentHeader, type CantonPaymentRequirements } from "@chainsafe/x402-core";
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
 * `X-PAYMENT` header. Non-402 responses — and 402s no payer can satisfy — pass
 * through unchanged.
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

    const accepts = await readAccepts(res);
    if (!accepts) return res; // not an x402 402 body → pass through

    const selection = select(accepts, list);
    if (!selection) return res; // no payer can satisfy any advertised requirement

    const payload = await selection.payer.authorize(selection.requirements);
    const headers = new Headers(init?.headers);
    headers.set("X-PAYMENT", encodePaymentHeader(payload, selection.requirements));
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

/** Read `accepts[]` from a 402 body without consuming the response (clone). */
async function readAccepts(res: Response): Promise<CantonPaymentRequirements[] | undefined> {
  try {
    const body = (await res.clone().json()) as { accepts?: unknown };
    return Array.isArray(body.accepts) ? (body.accepts as CantonPaymentRequirements[]) : undefined;
  } catch {
    return undefined;
  }
}
