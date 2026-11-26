// SPDX-License-Identifier: Apache-2.0

import type { JobInput } from "../../input.ts";

export function icsEvents(input: JobInput): { events: Array<{ summary?: string; start?: string; end?: string }> } {
  const text = input.text.replace(/\r\n/g, "\n");
  const blocks = text.split("BEGIN:VEVENT").slice(1);
  const events = blocks.map((block) => {
    const summary = /SUMMARY:(.+)/.exec(block)?.[1]?.trim();
    const start = /DTSTART[^:]*:(.+)/.exec(block)?.[1]?.trim();
    const end = /DTEND[^:]*:(.+)/.exec(block)?.[1]?.trim();
    return { summary, start, end };
  });
  return { events };
}