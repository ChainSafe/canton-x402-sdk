// A quantity in one unit, written as the other unit named in `other`.
//
// Temperature is converted. The rest are multiplied. Unknown units come back as an error
// on the result, after the call was paid, because the text was still one object.
//
// SPDX-License-Identifier: Apache-2.0

import type { JobInput } from "../input.ts";

const ALIASES: Record<string, string> = {
  f: "F",
  c: "C",
  fahrenheit: "F",
  celsius: "C",
  km: "km",
  mi: "mi",
  mile: "mi",
  miles: "mi",
  kg: "kg",
  lb: "lb",
  lbs: "lb",
  tbsp: "tbsp",
  ml: "ml",
  m: "m",
  ft: "ft",
};

export function run(input: JobInput): { quantity: string } | { error: string } {
  const match = /^(-?\d+(?:\.\d+)?)\s*([A-Za-z]+)$/.exec(input.text.trim());
  if (!match?.[1] || !match[2]) return { error: 'Write the quantity as "72 F" or "3 tbsp".' };
  const amount = Number(match[1]);
  const from = ALIASES[match[2].toLowerCase()];
  const to = ALIASES[(input.other ?? "").trim().toLowerCase()];
  if (!from || !to) return { error: "Units here are F, C, km, mi, kg, lb, tbsp, ml, m, ft." };
  if (from === to) return { quantity: `${trim(amount)} ${to}` };
  const converted = convert(amount, from, to);
  if (converted === undefined) return { error: `No conversion from ${from} to ${to}.` };
  return { quantity: `${trim(converted)} ${to}` };
}

function convert(amount: number, from: string, to: string): number | undefined {
  if (from === "F" && to === "C") return ((amount - 32) * 5) / 9;
  if (from === "C" && to === "F") return (amount * 9) / 5 + 32;
  const factor = FACTORS[`${from}>${to}`];
  return factor === undefined ? undefined : amount * factor;
}

const FACTORS: Record<string, number> = {
  "km>mi": 0.621371,
  "mi>km": 1.60934,
  "kg>lb": 2.20462,
  "lb>kg": 0.453592,
  "tbsp>ml": 14.7868,
  "ml>tbsp": 1 / 14.7868,
  "m>ft": 3.28084,
  "ft>m": 0.3048,
};

function trim(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}
