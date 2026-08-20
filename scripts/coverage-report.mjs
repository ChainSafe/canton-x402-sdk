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
 * With `--diff` it also reports PATCH coverage: of the lines this PR adds, how
 * many does a test execute. That's the question the workspace total can't answer
 * — a PR can add forty untested lines and still move the total up, by touching a
 * well-covered area or deleting uncovered code.
 *
 * Usage:
 *   node scripts/coverage-report.mjs [--base <summary.json>] [--base-label <text>]
 *                                    [--diff <unified diff>] [--dir <coverage dir>]
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
  const args = { base: null, baseLabel: "base", diff: null, pr: null, dir: "coverage" };
  const flags = {
    "--base": "base",
    "--base-label": "baseLabel",
    "--diff": "diff",
    "--pr": "pr",
    "--dir": "dir",
  };
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

/**
 * Line numbers each file GAINS in a unified diff, keyed by repo-relative path.
 * Only the new side matters: `+` lines advance (and are recorded), context lines
 * advance, `-` lines don't exist in the new file at all.
 */
function parseDiff(text) {
  const added = new Map();
  let file = null;
  let line = 0;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("+++ ")) {
      // `+++ /dev/null` is a deletion — nothing on the new side to cover.
      const target = raw.slice(4).trim();
      file = target === "/dev/null" ? null : target.replace(/^b\//, "");
      if (file && !added.has(file)) added.set(file, new Set());
      continue;
    }
    if (raw.startsWith("@@")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
      if (hunk) line = Number(hunk[1]);
      continue;
    }
    if (!file || line === 0) continue;
    if (raw.startsWith("+")) added.get(file).add(line++);
    else if (raw.startsWith("-") || raw.startsWith("\\"))
      continue; // removed line / "\ No newline"
    else line += 1; // context
  }
  return added;
}

/**
 * Per-line hit counts from lcov (`DA:<line>,<hits>`). vitest's v8 reporter emits
 * a DA record only for executable statements, so a line missing from this map is
 * a comment, a blank, or a type — correctly outside the patch denominator.
 */
function parseLcov(lcovPath) {
  const files = new Map();
  let current = null;
  for (const raw of readFileSync(lcovPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      current = new Map();
      files.set(line.slice(3), current);
    } else if (line.startsWith("DA:") && current) {
      const [no, hits] = line.slice(3).split(",");
      current.set(Number(no), Number(hits));
    }
  }
  return files;
}

/** Of the executable lines this PR adds, how many does a test execute. */
function patchCoverage(added, lcov) {
  const files = [];
  let total = 0;
  let covered = 0;
  for (const [file, lines] of added) {
    const hits = lcov.get(file);
    if (!hits) continue; // not a measured source file (docs, config, tests…)
    const missed = [];
    let fileTotal = 0;
    for (const line of [...lines].sort((a, b) => a - b)) {
      const count = hits.get(line);
      if (count === undefined) continue; // not executable
      fileTotal += 1;
      if (count > 0) covered += 1;
      else missed.push(line);
    }
    if (fileTotal === 0) continue;
    total += fileTotal;
    files.push({ file, total: fileTotal, missed });
  }
  files.sort((a, b) => b.missed.length - a.missed.length || a.file.localeCompare(b.file));
  return { total, covered, files };
}

/** "12, 14-17, 20" — compact enough to scan in a comment. */
function lineRanges(lines) {
  const ranges = [];
  for (const line of lines) {
    const last = ranges[ranges.length - 1];
    if (last && line === last[1] + 1) last[1] = line;
    else ranges.push([line, line]);
  }
  return ranges.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(", ");
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

/** `95.92% <100.00%> (+0.13%)` — Codecov's notation: total <patch> (delta). */
function coverageCell(metrics, basePkg, patchPct) {
  const total = fmtPct(metrics.lines);
  const patch = patchPct === null ? "ø" : `${patchPct.toFixed(2)}%`;
  const delta = basePkg
    ? fmtDelta(metrics.lines, basePkg.metrics.lines).replace("±0.00", "ø").replace("−", "-")
    : "?";
  const suffix = delta === "ø" || delta === "?" ? `(${delta})` : `(${delta}%)`;
  return `\`${total} <${patch}> ${suffix}\``;
}

/** `+12` / `-3` / "" — the change column, ASCII so it reads inside a diff fence. */
function signed(value, suffix = "", decimals = 0) {
  if (Math.abs(value) < (decimals ? 0.005 : 0.5)) return "";
  return `${value > 0 ? "+" : "-"}${Math.abs(value).toFixed(decimals)}${suffix}`;
}

/** `+` (green) when the row moved the right way, `-` (red) when it moved the wrong way. */
function mark(label, delta) {
  if (!delta) return " ";
  const up = delta.startsWith("+");
  const goodWhenUp = label === "Coverage" || label === "Hits";
  return up === goodWhenUp ? "+" : "-";
}

/**
 * The `@@ Coverage Diff @@` block. A fenced `diff` renders `+` lines green and
 * `-` lines red on GitHub, which is what makes it readable at a glance: coverage
 * and hits are green when they rise, misses green when they fall. Base columns
 * read `?` when no baseline was found — same as Codecov does.
 */
function renderDiffBlock({ total, base, packages, baseLabel, pr }) {
  const b = base?.total ?? null;
  const rows = [
    [
      "Coverage",
      b ? `${pct(b.lines).toFixed(2)}%` : "?",
      `${pct(total.lines).toFixed(2)}%`,
      b ? signed(pct(total.lines) - pct(b.lines), "%", 2) : "",
    ],
    "=",
    ["Packages", base?.packages?.length ?? "?", packages.length, ""],
    [
      "Lines",
      b?.lines.total ?? "?",
      total.lines.total,
      b ? signed(total.lines.total - b.lines.total) : "",
    ],
    [
      "Branches",
      b?.branches.total ?? "?",
      total.branches.total,
      b ? signed(total.branches.total - b.branches.total) : "",
    ],
    "=",
    [
      "Hits",
      b?.lines.covered ?? "?",
      total.lines.covered,
      b ? signed(total.lines.covered - b.lines.covered) : "",
    ],
    [
      "Misses",
      b ? b.lines.total - b.lines.covered : "?",
      total.lines.total - total.lines.covered,
      b ? signed(total.lines.total - total.lines.covered - (b.lines.total - b.lines.covered)) : "",
    ],
  ];

  const cells = rows.filter(Array.isArray);
  const w = [0, 1, 2, 3].map((i) => Math.max(...cells.map((row) => String(row[i]).length)));
  // The value columns also have to fit the header labels sitting above them.
  const headLabel = pr ? `#${pr}` : "PR";
  w[1] = Math.max(w[1], baseLabel.length);
  w[2] = Math.max(w[2], headLabel.length);
  w[3] = Math.max(w[3], 3);

  // Every line is laid out on the same grid — a 2-char lead (`+ `, `- `, `  `,
  // or `##`), the four columns, and a 5-char tail that the header spends on `##`.
  const row = (lead, [label, from, to, delta], tail = "     ") =>
    `${lead}${String(label).padEnd(w[0])}   ${String(from).padStart(w[1])}   ${String(to).padStart(
      w[2],
    )}   ${String(delta).padStart(w[3])}${tail}`;

  const body = rows.map((r) => (Array.isArray(r) ? row(`${mark(r[0], r[3])} `, r) : null));
  const header = row("##", ["", baseLabel, headLabel, "+/-"], "   ##");
  const width = header.length;
  const divider = "=".repeat(width);
  const title = " Coverage Diff ";
  const left = Math.floor((width - 4 - title.length) / 2);
  const banner = `@@${" ".repeat(left)}${title}${" ".repeat(width - 4 - left - title.length)}@@`;

  return ["```diff", banner, header, divider, ...body.map((l) => l ?? divider), "```"];
}

function renderMarkdown({ packages, total, base, baseLabel, patch, pr }) {
  const baseByName = new Map((base?.packages ?? []).map((pkg) => [pkg.name, pkg]));
  const patchPct = patch && patch.total > 0 ? (patch.covered / patch.total) * 100 : null;
  const missing = patch?.files.filter((file) => file.missed.length > 0) ?? [];
  const missedTotal = missing.reduce((sum, file) => sum + file.missed.length, 0);

  const verdict = [];
  if (patch && patch.total === 0) {
    verdict.push("ℹ️ This PR adds no executable lines, so there is no patch coverage to report.");
  } else if (patch && missedTotal > 0) {
    verdict.push(
      `⚠️ Patch coverage is \`${patchPct.toFixed(2)}%\` with \`${missedTotal} line${
        missedTotal === 1 ? "" : "s"
      }\` in your changes missing coverage. Please review.`,
    );
  } else if (patch) {
    verdict.push("✅ Patch coverage is `100.00%` — every line your changes add is covered.");
  }
  if (patch && !base) {
    verdict.push(
      `⚠️ No coverage report for BASE (\`${baseLabel}\`) yet, so the deltas below are unavailable.`,
    );
  }
  // The project number stays out of the collapsed section: a reviewer shouldn't
  // have to expand anything to see where the workspace stands.
  verdict.push(
    base
      ? `Project coverage is \`${fmtPct(total.lines)}\` (\`${fmtDelta(total.lines, base.total.lines).replace("−", "-")}%\` vs \`${baseLabel}\`).`
      : `Project coverage is \`${fmtPct(total.lines)}\` across ${packages.length} packages.`,
  );

  const missingTable = missing.length
    ? [
        "",
        "| Files with missing lines | Patch % | Lines |",
        "| :-- | --: | :-- |",
        ...missing.map((file) => {
          const filePct = (((file.total - file.missed.length) / file.total) * 100).toFixed(2);
          return `| \`${file.file}\` | ${filePct}% | ${file.missed.length} missing — ${lineRanges(
            file.missed,
          )} |`;
        }),
      ]
    : [];

  const flagged = packages
    .filter((pkg) => !pkg.tested || !pkg.reported)
    .map((pkg) =>
      pkg.reported
        ? `> ⚠️ \`${pkg.name}\` has no test files — every line of it is counted as uncovered.`
        : `> ⚠️ \`${pkg.name}\` has no coverage rows at all — is its \`src/\` inside the include glob in vitest.config.ts?`,
    );

  const patchByPackage = new Map();
  for (const file of patch?.files ?? []) {
    const owner = packages.find((pkg) => file.file.startsWith(`${pkg.relDir}/`));
    if (!owner) continue;
    const acc = patchByPackage.get(owner.name) ?? { total: 0, covered: 0 };
    acc.total += file.total;
    acc.covered += file.total - file.missed.length;
    patchByPackage.set(owner.name, acc);
  }

  return [
    // Lets CI find (and rewrite) its own sticky PR comment; invisible when rendered.
    MARKER,
    "## Coverage Report",
    ...(verdict.length ? ["", ...verdict] : []),
    ...missingTable,
    "",
    "<details><summary>Additional details and impacted packages</summary>",
    "",
    ...renderDiffBlock({ total, base, packages, baseLabel, pr }),
    "",
    "| Package | Coverage Δ | |",
    "| :-- | --: | :-- |",
    ...packages.map((pkg) => {
      const basePkg = baseByName.get(pkg.name);
      const own = patchByPackage.get(pkg.name);
      const cell = coverageCell(
        pkg.metrics,
        basePkg,
        own && own.total > 0 ? (own.covered / own.total) * 100 : null,
      );
      const arrow = basePkg
        ? ({ "+": "⬆️", "−": "⬇️" }[fmtDelta(pkg.metrics.lines, basePkg.metrics.lines)[0]] ?? "")
        : "";
      return `| \`${pkg.name}\` | ${cell} | ${arrow} |`;
    }),
    ...(flagged.length ? ["", ...flagged] : []),
    "",
    "</details>",
    "",
    "<sub>Measured by vitest + v8 over each package's `src/**` — tests, fixtures and `dist/` excluded. Patch coverage counts the executable lines this PR adds. lcov is attached to the run as the `coverage` artifact; `pnpm test:coverage` reproduces the report locally.</sub>",
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

// Patch coverage needs the PR's diff (CI writes it with `gh pr diff`) and lcov's
// per-line hits. Without a diff — a local run, or a push to main — the report is
// exactly what it was before: totals and the delta.
const lcovPath = join(coverageDir, "lcov.info");
const patch =
  args.diff && existsSync(args.diff) && existsSync(lcovPath)
    ? patchCoverage(parseDiff(readFileSync(args.diff, "utf8")), parseLcov(lcovPath))
    : null;
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
  patch,
  pr: args.pr,
});
writeFileSync(join(coverageDir, "summary.md"), `${markdown}\n`);
console.log(markdown);
