// Pretty-print JSON, or compact it when other is "compact".
//
// SPDX-License-Identifier: Apache-2.0

import type { JobInput } from "../input.ts";

export function run(input: JobInput): { json: string } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(input.text);
  } catch {
    return { error: "text is not JSON." };
  }
  const compact = input.other === "compact";
  return { json: JSON.stringify(value, null, compact ? undefined : 2) };
}
