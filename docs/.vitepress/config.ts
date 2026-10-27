// The docs site: navigation and shell only.
//
// The pages here are placeholders. The content arrives from the portal's
// `components/docs/doc-sections.tsx` (#68), and the TypeScript in it becomes
// files this workspace compiles rather than fenced blocks that rot (#69).
// Publishing, previews and CI are #70 — nothing here deploys.
//
// WHY THE SIDEBAR IS WRITTEN OUT rather than generated from the directory:
// these six pages are a reading order, not a folder. Someone meeting x402 for
// the first time should be walked from what it is to how to call it, and
// alphabetical or filesystem order would not do that.
import { defineConfig } from "vitepress";

export default defineConfig({
  // WHERE THE SITE IS SERVED FROM. GitHub project Pages serve under
  // /<repo>/, so assets referenced from "/" would 404. A custom domain serves
  // from the root instead: set DOCS_BASE=/ then, or drop this once the domain
  // is the only way in.
  base: process.env.DOCS_BASE ?? "/canton-x402-sdk/",
  title: "Canton x402",
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
