#!/usr/bin/env node
/**
 * Turn the workspace coverage run into a per-package report.
 *
 * `vitest run --coverage` (one run for every package — see vitest.config.ts)
 * leaves a single `coverage/` folder holding lcov + a per-FILE json summary.
 * This script rolls those files up per package and writes:
 *
 *   coverage/summary.json  — machine-readable per-package + workspace totals;
 *                            also the baseline CI diffs the next PR against
 *   coverage/summary.md    — the table posted on PRs / written to the job summary
 *
 * Per-package numbers stay front and centre — which library is thin matters more
 * than a blended workspace total — and a package with no tests shows up as a
 * flagged 0% row rather than quietly passing.
 *
 * Usage:
 *   node scripts/coverage-report.mjs [--base <summary.json>] [--base-label <text>]
 *                                    [--dir <coverage dir>]
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

const METRICS = /** @type {const} */ (["lines", "statements", "branches", "functions"]);

/** CI greps for this to find the sticky coverage comment it owns. */
const MARKER = "<!-- coverage-report -->";

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const NOT_SOURCE = new Set(["node_modules", "dist", "coverage", ".git"]);

function parseArgs(argv) {
  const args = { base: null, baseLabel: "base", dir: "coverage" };
  const flags = { "--base": "base", "--base-label": "baseLabel", "--dir": "dir" };
  for (let i = 0; i < argv.length; i += 1) {
    const key = flags[argv[i]];
    if (!key) throw new Error(`unknown argument: ${argv[i]}`);
    args[key] = argv[(i += 1)];
  }
  return args;
}

/** True when the package ships at least one vitest file (i.e. has any tests at all). */
function hasTests(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!NOT_SOURCE.has(entry.name) && hasTests(join(dir, entry.name))) return true;
    } else if (TEST_FILE.test(entry.name)) {
      return true;
    }
  }
  return false;
}

/** Every directory under `packages/` that is a package (has a package.json). */
function findPackages() {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(PACKAGES_DIR, e.name, "package.json")))
    .map((entry) => {
      const dir = join(PACKAGES_DIR, entry.name);
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      return {
        name: manifest.name ?? entry.name,
        dir,
        relDir: relative(REPO_ROOT, dir).split(sep).join("/"),
        tested: hasTests(dir),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const emptyMetric = () => ({ total: 0, covered: 0 });
const zeroMetrics = () => Object.fromEntries(METRICS.map((m) => [m, emptyMetric()]));

/** istanbul reports `pct` as "Unknown" for 0/0; treat "nothing to cover" as fully covered. */
const pct = ({ total, covered }) => (total === 0 ? 100 : (covered / total) * 100);

/** Roll the per-file entries of vitest's json-summary up to the package that owns them. */
function rollUp(packages, fileSummary) {
  const totals = new Map(packages.map((pkg) => [pkg.name, zeroMetrics()]));
  for (const [file, entry] of Object.entries(fileSummary)) {
    if (file === "total") continue;
    const owner = packages.find((pkg) => resolve(file).startsWith(pkg.dir + sep));
    if (!owner) continue; // outside packages/ — not ours to report
    const metrics = totals.get(owner.name);
    for (const metric of METRICS) {
      metrics[metric].total += entry[metric]?.total ?? 0;
      metrics[metric].covered += entry[metric]?.covered ?? 0;
    }
  }
  return packages.map((pkg) => {
    const metrics = totals.get(pkg.name);
    // No file rows at all means the coverage run never saw this package.
    const reported = METRICS.some((metric) => metrics[metric].total > 0);
    return { ...pkg, reported, metrics };
  });
}

function sumMetrics(packages) {
  return Object.fromEntries(
    METRICS.map((metric) => [
      metric,
      packages.reduce(
        (acc, pkg) => ({
          total: acc.total + pkg.metrics[metric].total,
          covered: acc.covered + pkg.metrics[metric].covered,
        }),
        emptyMetric(),
      ),
    ]),
  );
}

const fmtPct = (metric) => (metric.total === 0 ? "—" : `${pct(metric).toFixed(2)}%`);

function fmtDelta(current, base) {
  if (!base) return "—";
  const diff = pct(current) - pct(base);
  if (Math.abs(diff) < 0.005) return "±0.00";
  return `${diff > 0 ? "+" : "−"}${Math.abs(diff).toFixed(2)}`;
}

function renderMarkdown({ packages, total, base, baseLabel }) {
  const baseByName = new Map((base?.packages ?? []).map((pkg) => [pkg.name, pkg]));
  const delta = base ? ` · **${fmtDelta(total.lines, base.total.lines)} pp** vs ${baseLabel}` : "";

  const rows = packages.map((pkg) => {
    const basePkg = baseByName.get(pkg.name);
    // A package with no tests still gets a full 0% row (`all` reports files no
    // test ever imported), so it lands in the table and in the workspace total
    // instead of quietly passing.
    const label = pkg.tested ? `\`${pkg.name}\`` : `\`${pkg.name}\` ⚠️`;
    const lines = pkg.reported ? fmtPct(pkg.metrics.lines) : "not measured";
    return `| ${label} | ${lines} | ${fmtDelta(pkg.metrics.lines, basePkg?.metrics?.lines)} | ${fmtPct(
      pkg.metrics.branches,
    )} | ${fmtPct(pkg.metrics.functions)} | ${pkg.metrics.lines.covered}/${pkg.metrics.lines.total} |`;
  });

  const flagged = packages
    .filter((pkg) => !pkg.tested || !pkg.reported)
    .map((pkg) =>
      pkg.reported
        ? `> ⚠️ \`${pkg.name}\` has no test files — every line above is counted as uncovered.`
        : `> ⚠️ \`${pkg.name}\` has no coverage rows at all — is its \`src/\` inside the include glob in vitest.config.ts?`,
    );

  return [
    // Lets CI find (and rewrite) its own sticky PR comment; invisible when rendered.
    MARKER,
    "## Coverage",
    "",
    `**${fmtPct(total.lines)} of lines** across ${packages.length} package${
      packages.length === 1 ? "" : "s"
    }${delta}`,
    "",
    "| Package | Lines | Δ | Branches | Functions | Covered/Total |",
    "| :-- | --: | --: | --: | --: | --: |",
    ...rows,
    `| **Workspace** | **${fmtPct(total.lines)}** | **${fmtDelta(total.lines, base?.total?.lines)}** | **${fmtPct(
      total.branches,
    )}** | **${fmtPct(total.functions)}** | **${total.lines.covered}/${total.lines.total}** |`,
    ...(flagged.length ? ["", ...flagged] : []),
    "",
    "<sub>Measured by vitest + v8 over each package's `src/**` — tests, fixtures and `dist/` excluded. lcov is attached to the run as the `coverage` artifact; `pnpm test:coverage` reproduces this report locally.</sub>",
  ].join("\n");
}

const args = parseArgs(process.argv.slice(2));
const coverageDir = resolve(REPO_ROOT, args.dir);
const fileSummaryPath = join(coverageDir, "coverage-summary.json");
if (!existsSync(fileSummaryPath)) {
  console.error(
    `No coverage at ${relative(REPO_ROOT, fileSummaryPath)} — run \`pnpm test:coverage\`.`,
  );
  process.exit(1);
}

const packages = rollUp(findPackages(), JSON.parse(readFileSync(fileSummaryPath, "utf8")));
const total = sumMetrics(packages);
const base =
  args.base && existsSync(args.base) ? JSON.parse(readFileSync(args.base, "utf8")) : null;

const summary = {
  // Bumped when the shape changes, so a stale baseline artifact is ignored
  // rather than misread.
  schema: 1,
  total,
  packages: packages.map(({ name, relDir, tested, reported, metrics }) => ({
    name,
    dir: relDir,
    tested,
    reported,
    metrics,
  })),
};
writeFileSync(join(coverageDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

const markdown = renderMarkdown({
  packages,
  total,
  base: base?.schema === summary.schema ? base : null,
  baseLabel: args.baseLabel,
});
writeFileSync(join(coverageDir, "summary.md"), `${markdown}\n`);
console.log(markdown);
