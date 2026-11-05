import { defineConfig } from "tsup";
import { baseTsup } from "../../tsup.base";

// @chainsafe/x402-core is dual ESM+CJS, so it stays externalized. This package
// has no other runtime deps.
export default defineConfig({ ...baseTsup, entry: ["src/index.ts"] });
