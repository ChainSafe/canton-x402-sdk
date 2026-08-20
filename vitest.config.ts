import { fileURLToPath } from "node:url";

import { coverageConfigDefaults, defineConfig } from "vitest/config";

/**
 * One vitest run for the whole workspace. `projects` discovers every package
 * under packages/* — no per-package config file — and runs their suites in a
 * single process, which means a single coverage report: nothing to merge, and
 * one place where the coverage rules live. (Coverage is a root-level option in
 * `projects` mode; a project can't override it, by design.)
 *
 * The guard below matters: vitest looks for its config by walking UP from the
 * working directory, so `vitest run` inside packages/x402-core would find this
 * file too — and resolve `packages/*` against that package, finding no projects
 * and failing to start. Handing a package-level run an empty config lets it fall
 * back to vitest's defaults, which is exactly what `pnpm -r test` and
 * `pnpm --filter <pkg> test` expect: that package's own suite, nothing else.
 */
const REPO_ROOT = fileURLToPath(new URL(".", import.meta.url)).replace(/[/\\]$/, "");
const isWorkspaceRun = process.cwd() === REPO_ROOT;

export default isWorkspaceRun
  ? defineConfig({
      test: {
        projects: ["packages/*"],

        coverage: {
          provider: "v8",

          // Instrument the packages' SOURCES. The suites resolve their workspace
          // deps from `dist/` (see the build-first note in ci.yml), so an unscoped
          // include would also report those bundled artifacts. Scoping it to
          // `src/**` keeps every line attributed to the package that owns it —
          // x402-express's tests execute x402-core's `dist/`, and x402-core's
          // `src/` is correctly NOT credited for it.
          include: ["packages/*/src/**/*.ts"],

          // Report files no test ever imported (at 0%) instead of omitting them:
          // an untested module shouldn't be able to hide by never being loaded,
          // and a package with no tests at all should land in the table as a 0% row.
          all: true,

          exclude: [
            // node_modules, dist, *.test.*, *.d.ts, config files, …
            ...coverageConfigDefaults.exclude,
            // Test fixtures: test inputs, not shipped code.
            "**/*.fixtures.ts",
          ],

          reporter: [
            "text", // local runs: the table printed after the suite
            "lcov", // CI artifact (+ the HTML report under coverage/lcov-report)
            "json-summary", // per-file totals for scripts/coverage-report.mjs
          ],
          reportsDirectory: "coverage",
        },
      },
    })
  : defineConfig({});
