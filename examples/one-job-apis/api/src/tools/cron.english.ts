// Five-field cron, said as one sentence. Stars, numbers, and star-slash steps.
//
// SPDX-License-Identifier: Apache-2.0

import type { JobInput } from "../input.ts";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function run(input: JobInput): { sentence: string } {
  const fields = input.text.trim().split(/\s+/);
  if (fields.length !== 5) {
    return { sentence: "A cron expression here is five fields: minute, hour, day, month, weekday." };
  }
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  return {
    sentence: `${minutePhrase(minute)} ${hourPhrase(hour)}, ${dayPhrase(day)} ${monthPhrase(month)} ${weekdayPhrase(weekday)}.`.replace(
      /\s+/g,
      " ",
    ),
  };
}

function minutePhrase(field: string): string {
  if (field === "*") return "Every minute,";
  const step = starStep(field);
  if (step !== undefined) return `Every ${step} minutes,`;
  return `At minute ${field},`;
}

function hourPhrase(field: string): string {
  if (field === "*") return "every hour";
  const step = starStep(field);
  if (step !== undefined) return `every ${step} hours`;
  return `during hour ${field}`;
}

function dayPhrase(field: string): string {
  if (field === "*") return "every day";
  return `on day ${field}`;
}

function monthPhrase(field: string): string {
  if (field === "*") return "of every month";
  const index = Number(field);
  const name = MONTHS[index];
  return `of ${name ?? `month ${field}`}`;
}

function weekdayPhrase(field: string): string {
  if (field === "*") return "";
  const index = Number(field);
  const name = WEEKDAYS[index];
  return name !== undefined ? `on ${name}` : `on weekday ${field}`;
}

function starStep(field: string): number | undefined {
  const match = /^\*\/(\d+)$/.exec(field);
  if (!match?.[1]) return undefined;
  return Number(match[1]);
}
