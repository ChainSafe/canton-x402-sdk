// JSON rows (an array of objects) into CSV. Columns come from the first row.
//
// SPDX-License-Identifier: Apache-2.0

import type { JobInput } from "../input.ts";

export function run(input: JobInput): { csv: string } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(input.text);
  } catch {
    return { error: "text is not JSON." };
  }
  if (!Array.isArray(value) || value.some((row) => row === null || typeof row !== "object" || Array.isArray(row))) {
    return { error: "text must be a JSON array of objects." };
  }
  const rows = value as Record<string, unknown>[];
  const first = rows[0];
  if (first === undefined) return { csv: "" };
  const headers = Object.keys(first);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => cell(row[header])).join(","));
  }
  return { csv: lines.join("\n") };
}

function cell(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}
