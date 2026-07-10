import type { Options } from "tsup";

/**
 * Shared tsup preset for the @chainsafe/x402-* packages: dual ESM + CJS output
 * plus type declarations. Each package's tsup.config.ts spreads this and sets
 * its own `entry`. (Named tsup.base.ts, not tsup.config.ts, so tsup doesn't
 * treat this helper as a runnable config.)
 */
export const baseTsup: Options = {
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node18",
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".mjs" };
  },
};
