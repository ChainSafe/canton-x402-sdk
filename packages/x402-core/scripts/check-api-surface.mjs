// The published surface is a decision, not a side effect.
//
// `dist` is not tracked, so without this nothing in review shows that a new
// `export` added a semver-bound name. Compare the built declaration list
// against the committed one; a difference is either a deliberate API change
// (update api-surface.txt in the same commit, and say so in a changeset) or an
// accident, and the diff makes you choose.
//
// Read every `export` statement, not just the final clause. A name re-exported
// from a package the bundler left external gets its own statement at the TOP of
// the `.d.ts`, so reading the last line alone published vendor names into the
// frozen surface with this check still green.
//
// The declarations alone are not enough either. A name that is both a value and
// a type — `HashingSchemeVersion` is declared as each — keeps its bare spelling
// in the export clause whether `index.ts` re-exports the value or only the type,
// because the marker follows the kind of the declaration rather than the kind of
// the re-export. Demote one and the list never moves while the value disappears
// from the bundle. So the names that are not marked `type` are checked again
// against what the built ESM and CJS actually export at runtime.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const at = (p) => join(here, "..", p);
const read = (p) => readFileSync(at(p), "utf8");

const names = [];
const foreign = [];
const unparsed = [];
for (const statement of read("dist/index.d.ts").match(/^export\b[^;]*;/gm) ?? []) {
  const clause = statement.match(/^export\s+(type\s+)?\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?\s*;$/);
  if (!clause) {
    unparsed.push(statement.split("\n")[0]);
    continue;
  }
  const [, typeOnly, body, from] = clause;
  if (from) {
    foreign.push(`${from}: ${body.trim()}`);
    continue;
  }
  for (const name of body.split(",").map((n) => n.trim()).filter(Boolean)) {
    names.push(typeOnly ? `type ${name.replace(/^type\s+/, "")}` : name);
  }
}
const built = names.sort();

// `export * from`, `export default`, a `declare module` augmentation: shapes
// this parse does not understand, so it cannot vouch for the list.
if (unparsed.length) {
  console.error("An export statement in dist/index.d.ts was not understood:\n");
  for (const u of unparsed) console.error(`    ${u}`);
  console.error("\nTeach this script the shape before trusting its answer.");
  process.exit(1);
}

// core inlines every dependency — `noExternal` for the code, `dts.resolve` for
// the types — so nothing should survive as a re-export. One that does publishes
// a vendor name, and the declaration does not say whether it is a value or a
// type, so neither comparison below can judge it.
if (foreign.length) {
  console.error("dist/index.d.ts re-exports from a package that was not inlined:\n");
  for (const f of foreign) console.error(`    ${f}`);
  console.error(
    "\nThat name joins the published surface, and 1.0.0 freezes it. Inline the\n" +
      "package (noExternal / dts.resolve) or stop re-exporting from it.",
  );
  process.exit(1);
}

const locked = read("api-surface.txt")
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

const problems = [];
const compare = (surface, expected, actual) => {
  const added = actual.filter((n) => !expected.includes(n));
  const removed = expected.filter((n) => !actual.includes(n));
  if (added.length || removed.length) problems.push({ surface, added, removed });
};

compare("dist/index.d.ts", locked, built);

// A `type`-marked name has nothing to export at runtime; every other one must
// be there, in both module formats.
const values = locked.filter((n) => !n.startsWith("type "));
compare("dist/index.mjs", values, Object.keys(await import(pathToFileURL(at("dist/index.mjs")).href)).sort());
compare("dist/index.cjs", values, Object.keys(createRequire(import.meta.url)(at("dist/index.cjs"))).sort());

if (problems.length === 0) {
  console.log(`api surface unchanged (${built.length} names, ${values.length} of them values)`);
  process.exit(0);
}
console.error("The published API surface changed.\n");
for (const { surface, added, removed } of problems) {
  console.error(`  ${surface}`);
  for (const n of added) console.error(`    + ${n}`);
  for (const n of removed) console.error(`    - ${n}`);
  console.error("");
}
console.error(
  "If that is intended, run `pnpm build` then refresh api-surface.txt in the\n" +
    "same commit, and add a changeset saying what moved. A removal is a MAJOR.\n" +
    "A name missing only at runtime was demoted to a type-only export, which\n" +
    "the declarations cannot show.",
);
process.exit(1);
