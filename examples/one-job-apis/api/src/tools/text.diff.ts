// Line-by-line diff of text against other. Not a patience diff: same index, or both lines.
//
// SPDX-License-Identifier: Apache-2.0

import type { JobInput } from "../input.ts";

export function run(input: JobInput): { diff: string } {
  const left = input.text.split("\n");
  const right = (input.other ?? "").split("\n");
  const lines: string[] = [];
  const count = Math.max(left.length, right.length);
  for (let i = 0; i < count; i++) {
    const a = left[i];
    const b = right[i];
    if (a === b) {
      lines.push(`  ${a ?? ""}`);
      continue;
    }
    if (a !== undefined) lines.push(`- ${a}`);
    if (b !== undefined) lines.push(`+ ${b}`);
  }
  return { diff: lines.join("\n") };
}
