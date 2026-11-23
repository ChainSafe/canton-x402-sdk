// Mask emails, card-shaped numbers, and phone-shaped numbers.
//
// SPDX-License-Identifier: Apache-2.0

import type { JobInput } from "../input.ts";

export function run(input: JobInput): { text: string } {
  const text = input.text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[card]")
    .replace(/\+?\d[\d ().-]{7,}\d/g, "[phone]");
  return { text };
}
