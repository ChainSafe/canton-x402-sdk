// The docs site: navigation, the shell, and one check on the code excerpts.
//
// The pages came from the portal's `components/docs/doc-sections.tsx` (#68).
// The TypeScript they show is not pasted: it lives in docs/snippets, which the
// workspace compiles, and the pages transclude it (#69).
//
// WHY THE SIDEBAR IS WRITTEN OUT rather than generated from the directory:
// each section is a reading order, not a folder. Get started is a task to do,
// Guides are tasks beyond the first one, Concepts is what to understand once it
// works, Reference is what to look up, and within each the pages go in the
// order a newcomer needs them.
//
// The one exception is the SDK APIs reference under /api/: TypeDoc generates it
// from the packages' source on every build (`pnpm docs:api`), so it describes
// the code being published rather than a copy someone remembered to refresh.
// It is gitignored for the same reason.
//
// Pages that moved are sent on from their old URLs by theme/redirects.ts.
import { existsSync, readFileSync } from "node:fs";

import { defineConfig } from "vitepress";

/** The sidebar, and the nav's dropdowns: one list, so the two cannot drift. */
const SECTIONS = [
  {
    text: "Get started",
    items: [
      { text: "Accept payments", link: "/get-started/accept-payments" },
      { text: "Pay for an API", link: "/get-started/pay-for-an-api" },
      { text: "Networks", link: "/get-started/networks" },
    ],
  },
  {
    text: "Guides",
    items: [
      { text: "Express middleware", link: "/guides/express-middleware" },
      { text: "Payer SDK", link: "/guides/payer-sdk" },
      { text: "Facilitator client", link: "/guides/facilitator-client" },
      { text: "Pending payments", link: "/guides/pending-payments" },
      { text: "Upgrading to 1.0", link: "/guides/upgrading-to-1-0" },
    ],
  },
  {
    text: "Concepts",
    items: [
      { text: "The facilitator", link: "/concepts/facilitator" },
      { text: "The payment flow", link: "/concepts/payment-flow" },
    ],
  },
  {
    text: "Reference",
    items: [
      { text: "Facilitator APIs", link: "/reference/http-api" },
      { text: "Error codes", link: "/reference/error-codes" },
      { text: "SDK APIs", link: "/api/" },
      { text: "Protocol spec", link: "/protocol/spec" },
    ],
  },
];

/**
 * The SDK APIs' own sidebar: one collapsed entry per package, written by
 * TypeDoc beside the pages. Missing when `vitepress dev` runs without
 * `pnpm docs:api` first; the build always generates it, and its dead-link
 * check fails on the "SDK APIs" link if it never was.
 */
const API_SIDEBAR_FILE = new URL("../api/typedoc-sidebar.json", import.meta.url);
const API_SIDEBAR = existsSync(API_SIDEBAR_FILE)
  ? JSON.parse(readFileSync(API_SIDEBAR_FILE, "utf8"))
  : [];

export default defineConfig({
  // WHERE THE SITE IS SERVED FROM. GitHub project Pages serve under
  // /<repo>/, so assets referenced from "/" would 404. A custom domain serves
  // from the root instead: set DOCS_BASE=/ then, or drop this once the domain
  // is the only way in.
  base: process.env.DOCS_BASE ?? "/canton-x402-sdk/",
  title: "x402 on Canton",
  // docs/snippets is code the pages transclude, plus the CHANGELOG its package
  // gets from changesets: none of it is a page.
  srcExclude: ["snippets/**"],
  markdown: {
    // A `<<< file#region` whose region does not exist renders the WHOLE file,
    // silently: rename a region and a 40-line program becomes the file with its
    // header. This runs after VitePress's own snippet renderer, on the token it
    // filled, so it sees exactly what VitePress resolved, and fails the page.
    config(md) {
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const html = fence(tokens, idx, options, env, self);
        const [file, region] = (tokens[idx] as { src?: [string, string] }).src ?? [];
        if (file && region) {
          const whole = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
          if (tokens[idx].content === whole) {
            throw new Error(`docs: ${file} has no region "${region}" (${env.relativePath})`);
          }
        }
        return html;
      };
    },
  },
  description:
    "Pay for an HTTP request on Canton: the x402 facilitator, and the SDK that talks to it.",
  themeConfig: {
    // The home page has no sidebar (VitePress's home layout never shows one),
    // so the nav carries every section as a dropdown: any page is one click
    // from anywhere, the home page included.
    nav: [
      ...SECTIONS.map((section) => ({ text: section.text, items: section.items })),
      { text: "npm", link: "https://www.npmjs.com/org/chainsafe" },
    ],
    // The SDK APIs keep the guide's sections above its own tree, so a
    // reader looking up a type is still one click from the page that uses it.
    sidebar: {
      "/api/": [...SECTIONS, { text: "SDK APIs", link: "/api/", items: API_SIDEBAR }],
      "/": SECTIONS,
    },
    socialLinks: [{ icon: "github", link: "https://github.com/ChainSafe/canton-x402-sdk" }],
    search: { provider: "local" },
  },
});
