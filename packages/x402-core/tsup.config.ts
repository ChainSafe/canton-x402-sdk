import { defineConfig } from "tsup";
import { baseTsup } from "../../tsup.base";

export default defineConfig({ ...baseTsup, entry: ["src/index.ts"] });
