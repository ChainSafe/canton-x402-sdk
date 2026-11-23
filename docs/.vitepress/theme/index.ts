// The default theme, plus one thing: sending links to moved pages on to where
// they went (see redirects.ts).
import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";

import { redirectFor } from "./redirects";

export default {
  extends: DefaultTheme,
  enhanceApp() {
    if (typeof window === "undefined") return;
    const to = redirectFor(location.pathname, location.hash, import.meta.env.BASE_URL);
    if (to) location.replace(to);
  },
} satisfies Theme;
