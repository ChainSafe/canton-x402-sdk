import { defineConfig } from "tsup";
import { baseTsup } from "../../tsup.base";

// x402-core, x402-client are dual ESM+CJS; express is a peer dependency. All are
// externalized. The CJS build matters here — classic Express apps are often CJS.
export default defineConfig({ ...baseTsup, entry: ["src/index.ts"] });
