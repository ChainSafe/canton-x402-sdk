import { defineConfig } from "tsup";
import { baseTsup } from "../../tsup.base";

// @chainsafe/* and @canton-network/wallet-sdk are all dual ESM+CJS, so everything
// is externalized (no bundling). wallet-sdk pulls a large @canton-network/core-*
// tree — never bundle it.
export default defineConfig({ ...baseTsup, entry: ["src/index.ts"] });
