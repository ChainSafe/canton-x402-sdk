// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import type { JobInput } from "../input.ts";

export function requireOther(input: JobInput, label = "other"): string {
  const v = input.other?.trim();
  if (!v) throw new Error(`${label} is required.`);
  return v;
}

export function decodeBase64Payload(text: string): Buffer {
  const dataUrl = /^data:[^;]+;base64,(.+)$/i.exec(text.trim());
  const raw = dataUrl?.[1] ?? text.trim();
  try {
    return Buffer.from(raw, "base64");
  } catch {
    throw new Error("Expected base64 or a data URL.");
  }
}

export function toDataUrl(mime: string, buf: Buffer): string {
  return `data:${mime};base64,${buf.toString("base64")}`;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? 12_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const target = new URL(url);
    if (!["http:", "https:"].includes(target.protocol)) {
      throw new Error("Only http and https URLs are allowed.");
    }
    return await fetch(url, { ...init, signal: ctrl.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

export function parseViewport(other: string): { width: number; height: number } {
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(other.trim());
  if (!m?.[1] || !m[2]) throw new Error('Viewport must look like "1280x720".');
  return { width: Number(m[1]), height: Number(m[2]) };
}