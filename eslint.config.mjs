import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // docs/.vitepress/cache holds the dev server's pre-bundled deps (gitignored, but
  // `pnpm lint` after `pnpm docs:dev` would otherwise lint vendored Vue).
  { ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "docs/.vitepress/cache/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // Underscore-prefixed identifiers are intentionally unused (e.g. mock
      // params kept only to shape a tuple type).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // Plain-JS Node scripts (e.g. example bootstrap scripts) — provide Node globals
    // (TS files get these implicitly; typescript-eslint turns off no-undef for them).
    files: ["**/*.mjs", "**/scripts/**/*.js"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        URL: "readonly",
      },
    },
  },
);
