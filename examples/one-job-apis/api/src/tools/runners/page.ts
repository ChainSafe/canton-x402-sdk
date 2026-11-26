// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import pdf from "pdf-parse";
import { PDFDocument, degrees } from "pdf-lib";

import type { JobInput } from "../../input.ts";
import { decodeBase64Payload, requireOther, toDataUrl } from "../helpers.ts";

function pdfBuf(input: JobInput): Buffer {
  return decodeBase64Payload(input.text);
}

export async function pdfText(input: JobInput): Promise<{ text: string }> {
  const parsed = await pdf(pdfBuf(input));
  return { text: parsed.text.trim() };
}

export async function pdfTables(input: JobInput): Promise<{ rows: string[][] }> {
  const { text } = await pdfText(input);
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.split(/\s{2,}|\t/).map((c) => c.trim()).filter(Boolean))
    .filter((r) => r.length > 0);
  return { rows };
}

export async function pdfMerge(input: JobInput): Promise<{ pdf: string }> {
  const parts = input.text.split(/\n---\n/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) throw new Error('Put base64 PDFs in text, separated by "\\n---\\n".');
  const out = await PDFDocument.create();
  for (const part of parts) {
    const src = await PDFDocument.load(decodeBase64Payload(part));
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const page of pages) out.addPage(page);
  }
  return { pdf: toDataUrl("application/pdf", Buffer.from(await out.save())) };
}

export async function pdfSplit(input: JobInput): Promise<{ pdf: string }> {
  const range = requireOther(input, "page range");
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(range);
  if (!m?.[1] || !m[2]) throw new Error('Range must look like "1-3".');
  const start = Number(m[1]) - 1;
  const end = Number(m[2]) - 1;
  const src = await PDFDocument.load(pdfBuf(input));
  const out = await PDFDocument.create();
  const indices = Array.from({ length: end - start + 1 }, (_, i) => start + i).filter(
    (i) => i >= 0 && i < src.getPageCount(),
  );
  const pages = await out.copyPages(src, indices);
  for (const page of pages) out.addPage(page);
  return { pdf: toDataUrl("application/pdf", Buffer.from(await out.save())) };
}

export async function pdfCompress(input: JobInput): Promise<{ pdf: string; bytes: number }> {
  const bytes = await (await PDFDocument.load(pdfBuf(input))).save({ useObjectStreams: true });
  return { pdf: toDataUrl("application/pdf", Buffer.from(bytes)), bytes: bytes.byteLength };
}

export async function pdfFromHtml(input: JobInput): Promise<{ pdf: string }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const lines = input.text.match(/.{1,88}/g) ?? [];
  let y = 750;
  for (const line of lines.slice(0, 50)) {
    page.drawText(line, { x: 48, y, size: 11, maxWidth: 520 });
    y -= 14;
  }
  return { pdf: toDataUrl("application/pdf", Buffer.from(await doc.save())) };
}

export async function officePdf(input: JobInput): Promise<{ note: string }> {
  return {
    note: "Office conversion needs LibreOffice in the worker image. Send a PDF via pdf.text instead.",
  };
}

export async function pdfMeta(input: JobInput): Promise<{ pages: number }> {
  const parsed = await pdf(pdfBuf(input));
  return { pages: parsed.numpages };
}

export async function pdfImages(input: JobInput): Promise<{ count: number }> {
  const parsed = await pdf(pdfBuf(input));
  return { count: (parsed as { images?: unknown[] }).images?.length ?? 0 };
}

export async function pdfRotate(input: JobInput): Promise<{ pdf: string }> {
  const turn = Number.parseInt(requireOther(input, "quarter-turn"), 10);
  if (![90, 180, 270].includes(turn)) throw new Error("Use 90, 180, or 270.");
  const doc = await PDFDocument.load(pdfBuf(input));
  const pages = doc.getPages();
  for (const page of pages) page.setRotation(degrees(turn));
  return { pdf: toDataUrl("application/pdf", Buffer.from(await doc.save())) };
}