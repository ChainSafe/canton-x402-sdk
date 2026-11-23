// A media type from the start of the text. Magic bytes win, then a glance at the shape.
//
// SPDX-License-Identifier: Apache-2.0

import type { JobInput } from "../input.ts";

export function run(input: JobInput): { mediaType: string } {
  const bytes = Buffer.from(input.text, "utf8");
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mediaType: "image/png" };
  }
  if (bytes.subarray(0, 3).toString("utf8") === "GIF") return { mediaType: "image/gif" };
  if (bytes.subarray(0, 5).toString("utf8") === "%PDF-") return { mediaType: "application/pdf" };
  const trimmed = input.text.trimStart();
  if (trimmed.startsWith("<")) return { mediaType: "text/html" };
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return { mediaType: "application/json" };
  return { mediaType: "text/plain" };
}
