import { defineConfig } from "tsup";
import { baseTsup } from "../../tsup.base";

// Bundle @noble/hashes into the output: it's ESM-only (v2), so leaving it
// external would break the CJS build's require(). Inlining it also makes core
// self-contained (zero runtime deps) across ESM/CJS/browser.
export default defineConfig({
  ...baseTsup,
  entry: ["src/index.ts"],
  noExternal: ["@noble/hashes"],
});
