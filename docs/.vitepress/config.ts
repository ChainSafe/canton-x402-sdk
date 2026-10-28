// The docs site: navigation, the shell, and one check on the code excerpts.
//
// The pages came from the portal's `components/docs/doc-sections.tsx` (#68).
// The TypeScript they show is not pasted: it lives in docs/snippets, which the
// workspace compiles, and the pages transclude it (#69).
//
// WHY THE SIDEBAR IS WRITTEN OUT rather than generated from the directory:
// these six pages are a reading order, not a folder. Someone meeting x402 for
// the first time should be walked from what it is to how to call it, and
// alphabetical or filesystem order would not do that.
import { readFileSync } from "node:fs";

import { defineConfig } from "vitepress";

export default defineConfig({
  // WHERE THE SITE IS SERVED FROM. GitHub project Pages serve under
  // /<repo>/, so assets referenced from "/" would 404. A custom domain serves
  // from the root instead: set DOCS_BASE=/ then, or drop this once the domain
  // is the only way in.
  base: process.env.DOCS_BASE ?? "/canton-x402-sdk/",
  title: "Canton x402",
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
    nav: [
      { text: "Guide", link: "/" },
      { text: "API reference", link: "/api-reference" },
      { text: "npm", link: "https://www.npmjs.com/org/chainsafe" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "The x402 facilitator", link: "/" },
          { text: "Getting started", link: "/getting-started" },
          { text: "The payment flow", link: "/payment-flow" },
          { text: "The facilitator", link: "/facilitator" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "API reference", link: "/api-reference" },
          { text: "Protocol spec", link: "/protocol/spec" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/ChainSafe/canton-x402-sdk" }],
    search: { provider: "local" },
  },
});
