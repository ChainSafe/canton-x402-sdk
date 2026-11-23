// Where the pages that moved went, so a link to the old URL still lands.
//
// GitHub Pages cannot redirect: an old path is served the site's 404.html,
// which boots the app, and the theme sends it on from here. That is also why
// this runs in the browser and not in the build — only the browser sees the
// #fragment, and two old anchors moved to a different page than the rest of
// theirs (the buyer half of Getting started, and two sections of the old
// overview).

/** Old path (without base or `.html`) → new path, per fragment or for any. */
const MOVED: Record<string, { any?: string; hash?: Record<string, string> }> = {
  "/getting-started": {
    any: "/get-started/accept-payments",
    hash: { "#the-buyer-side": "/get-started/pay-for-an-api" },
  },
  "/payment-flow": { any: "/concepts/payment-flow" },
  "/facilitator": { any: "/concepts/facilitator" },
  "/api-reference": { any: "/reference/http-api" },
  "/": {
    hash: {
      "#non-custodial-by-construction": "/concepts/facilitator",
      "#the-payment-scheme": "/concepts/facilitator",
      "#how-you-get-paid": "/concepts/facilitator",
      "#your-api-key-is-the-facilitator-credential": "/concepts/facilitator",
    },
  },
};

/**
 * Where `pathname` + `hash` moved to, under `base`, or undefined if it did not
 * move. The fragment is kept: section ids did not change, and one with no
 * section on the new page just lands at its top.
 */
export function redirectFor(pathname: string, hash: string, base: string): string | undefined {
  if (!pathname.startsWith(base)) return undefined;
  const rest = pathname
    .slice(base.length)
    .replace(/\.html$/, "")
    .replace(/(^|\/)index$/, "");
  const moved = MOVED["/" + rest.replace(/\/$/, "")];
  const to = moved?.hash?.[hash] ?? moved?.any;
  return to ? `${base}${to.slice(1)}.html${hash}` : undefined;
}
