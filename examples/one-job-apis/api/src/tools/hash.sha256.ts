// sha256 of the text, as hex.
//
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { JobInput } from "../input.ts";

export function run(input: JobInput): { hex: string } {
  return { hex: createHash("sha256").update(input.text).digest("hex") };
}
