// The default theme, plus the home page's components (registered globally so
// index.md can place them as tags) and sending links to moved pages on to
// where they went (see redirects.ts).
import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";

import IntegrationPaths from "./components/IntegrationPaths.vue";
import PaymentFlow from "./components/PaymentFlow.vue";
import { redirectFor } from "./redirects";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("IntegrationPaths", IntegrationPaths);
    app.component("PaymentFlow", PaymentFlow);
    if (typeof window === "undefined") return;
    const to = redirectFor(location.pathname, location.hash, import.meta.env.BASE_URL);
    if (to) location.replace(to);
  },
} satisfies Theme;
