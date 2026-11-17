// The published surface is a decision, not a side effect.
//
// `dist` is not tracked, so without this nothing in review shows that a new
// `export` added a semver-bound name. Compare the built declaration list
// against the committed one; a difference is either a deliberate API change
// (update api-surface.txt in the same commit, and say so in a changeset) or an
// accident, and the diff makes you choose.
//
// The TYPE markers matter as much as the names. A value demoted to a type-only
// export keeps its name in the list while silently disappearing at runtime —
// that happened once already here, to HashingSchemeVersion, which is declared
// as both a const and a type.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

const built = read("dist/index.d.ts")
  .trimEnd()
  .split("\n")
  .at(-1)
  .replace(/^export \{/, "")
  .replace(/\};?$/, "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .sort();

const locked = read("api-surface.txt").split("\n").map((s) => s.trim()).filter(Boolean);

const added = built.filter((n) => !locked.includes(n));
const removed = locked.filter((n) => !built.includes(n));

if (added.length === 0 && removed.length === 0) {
  console.log(`api surface unchanged (${built.length} names)`);
  process.exit(0);
}
console.error("The published API surface changed.\n");
for (const n of added) console.error(`  + ${n}`);
for (const n of removed) console.error(`  - ${n}`);
console.error(
  "\nIf that is intended, run `pnpm build` then refresh api-surface.txt in the\n" +
    "same commit, and add a changeset saying what moved. A removal is a MAJOR.",
);
process.exit(1);
