// SPDX-License-Identifier: Apache-2.0

import { marked } from "marked";

import type { JobInput } from "../../input.ts";
import { requireOther } from "../helpers.ts";

export function textTranslate(input: JobInput): { target: string; text: string } {
  const target = requireOther(input, "target language");
  return { target, text: input.text };
}

export function textSummary(input: JobInput): { summary: string } {
  const budget = Number.parseInt(requireOther(input, "word budget"), 10);
  if (!Number.isFinite(budget) || budget < 1) throw new Error("Word budget must be a positive integer.");
  const words = input.text.trim().split(/\s+/);
  return { summary: words.slice(0, budget).join(" ") };
}

export function textLang(input: JobInput): { language: string } {
  const sample = input.text.slice(0, 200);
  const scores: Record<string, number> = {
    en: (sample.match(/\b(the|and|is|to)\b/gi) ?? []).length,
    es: (sample.match(/\b(el|la|y|de)\b/gi) ?? []).length,
    fr: (sample.match(/\b(le|la|et|de)\b/gi) ?? []).length,
    de: (sample.match(/\b(der|die|und|ist)\b/gi) ?? []).length,
  };
  const language = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "und";
  return { language };
}

export function mdHtml(input: JobInput): { html: string } {
  return { html: marked.parse(input.text, { async: false }) as string };
}

export function dateParse(input: JobInput): { iso: string; timezone: string } {
  const timezone = requireOther(input, "timezone");
  const ms = Date.parse(input.text);
  if (Number.isNaN(ms)) throw new Error("Could not parse that date phrase.");
  return { iso: new Date(ms).toISOString(), timezone };
}

export function regexExplain(input: JobInput): { pattern: string; flags: string; summary: string } {
  let pattern = input.text.trim();
  let flags = "";
  const slash = /^\/([\s\S]+)\/([gimsuy]*)$/.exec(pattern);
  if (slash?.[1]) {
    pattern = slash[1];
    flags = slash[2] ?? "";
  }
  try {
    const re = new RegExp(pattern, flags);
    return {
      pattern,
      flags,
      summary: `Matches strings where /${pattern}/${flags} succeeds (tested: ${String(re.test("sample"))}).`,
    };
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : "Invalid pattern.");
  }
}