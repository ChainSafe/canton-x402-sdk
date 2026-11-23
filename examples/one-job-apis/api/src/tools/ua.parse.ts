// Browser and OS named in a user-agent. Coarse on purpose.
//
// SPDX-License-Identifier: Apache-2.0

import type { JobInput } from "../input.ts";

export function run(input: JobInput): { browser: string; os: string } {
  return { browser: browser(input.text), os: os(input.text) };
}

function browser(ua: string): string {
  if (ua.includes("Edg/")) return "Edge";
  if (ua.includes("Chrome/")) return "Chrome";
  if (ua.includes("Firefox/")) return "Firefox";
  if (ua.includes("Safari/") && ua.includes("Version/")) return "Safari";
  return "unknown";
}

function os(ua: string): string {
  if (ua.includes("iPhone") || ua.includes("iPad")) return "iOS";
  if (ua.includes("Android")) return "Android";
  if (ua.includes("Mac OS X")) return "macOS";
  if (ua.includes("Windows")) return "Windows";
  if (ua.includes("Linux")) return "Linux";
  return "unknown";
}
