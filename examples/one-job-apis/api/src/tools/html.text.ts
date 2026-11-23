// Visible text of an HTML snippet. Scripts and styles are dropped first.
//
// SPDX-License-Identifier: Apache-2.0

import type { JobInput } from "../input.ts";

export function run(input: JobInput): { text: string } {
  const stripped = input.text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&nbsp;", " ")
    .replace(/\s+/g, " ")
    .trim();
  return { text: stripped };
}
