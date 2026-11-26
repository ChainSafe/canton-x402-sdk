// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import * as cheerio from "cheerio";
import { PDFDocument } from "pdf-lib";

import type { JobInput } from "../../input.ts";
import { fetchWithTimeout, parseViewport, requireOther, toDataUrl } from "../helpers.ts";

async function loadHtml(url: string): Promise<{ html: string; finalUrl: string }> {
  const res = await fetchWithTimeout(url);
  const html = await res.text();
  return { html, finalUrl: res.url };
}

export async function urlMeta(input: JobInput): Promise<{ title?: string; description?: string; image?: string }> {
  const { html, finalUrl } = await loadHtml(input.text.trim());
  const $ = cheerio.load(html);
  const image =
    $('meta[property="og:image"]').attr("content") ??
    $('meta[name="twitter:image"]').attr("content") ??
    undefined;
  return {
    title: $("title").first().text().trim() || $('meta[property="og:title"]').attr("content"),
    description:
      $('meta[name="description"]').attr("content") ?? $('meta[property="og:description"]').attr("content"),
    image: image ? new URL(image, finalUrl).href : undefined,
  };
}

export async function urlRead(input: JobInput): Promise<{ text: string }> {
  const { html } = await loadHtml(input.text.trim());
  const $ = cheerio.load(html);
  $("script, style, nav, footer, aside").remove();
  return { text: $("body").text().replace(/\s+/g, " ").trim() };
}

export async function urlStatus(input: JobInput): Promise<{ status: number; chain: string[] }> {
  const chain: string[] = [];
  let url = input.text.trim();
  for (let i = 0; i < 8; i++) {
    const res = await fetchWithTimeout(url, { method: "HEAD", redirect: "manual" });
    chain.push(`${res.status} ${url}`);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) break;
      url = new URL(loc, url).href;
      continue;
    }
    return { status: res.status, chain };
  }
  throw new Error("Too many redirects.");
}

export async function urlUnshort(input: JobInput): Promise<{ url: string }> {
  const res = await fetchWithTimeout(input.text.trim(), { method: "HEAD", redirect: "follow" });
  return { url: res.url };
}

export async function urlFavicon(input: JobInput): Promise<{ png: string }> {
  const host = input.text.trim().replace(/^https?:\/\//i, "").split("/")[0];
  const url = `https://${host}/favicon.ico`;
  const res = await fetchWithTimeout(url);
  const buf = Buffer.from(await res.arrayBuffer());
  return { png: toDataUrl("image/png", buf) };
}

export async function urlShot(input: JobInput): Promise<{ note: string; viewport: string }> {
  const viewport = requireOther(input, "viewport");
  parseViewport(viewport);
  return {
    note: "Headless capture is not bundled in this demo build. Use url.read or url.meta for live fetches.",
    viewport,
  };
}

export async function urlPdf(input: JobInput): Promise<{ pdf: string }> {
  const { html, finalUrl } = await loadHtml(input.text.trim());
  const $ = cheerio.load(html);
  $("script, style, nav, footer, aside").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const lines = [`Source: ${finalUrl}`, "", ...text.slice(0, 3500).match(/.{1,90}/g) ?? []];
  let y = 750;
  for (const line of lines.slice(0, 44)) {
    page.drawText(line, { x: 48, y, size: 10, maxWidth: 520 });
    y -= 14;
    if (y < 48) break;
  }
  const bytes = await doc.save();
  return { pdf: toDataUrl("application/pdf", Buffer.from(bytes)) };
}