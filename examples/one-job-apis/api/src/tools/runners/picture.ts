// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import jsQR from "jsqr";
import QRCode from "qrcode";
import sharp from "sharp";

import type { JobInput } from "../../input.ts";
import { decodeBase64Payload, requireOther, toDataUrl } from "../helpers.ts";

async function sharpBuf(input: JobInput): Promise<sharp.Sharp> {
  return sharp(decodeBase64Payload(input.text));
}

export async function bgRemove(input: JobInput): Promise<{ png: string }> {
  const buf = await (await sharpBuf(input)).flatten({ background: "#ffffff" }).png().toBuffer();
  return { png: toDataUrl("image/png", buf) };
}

export async function imgCompress(input: JobInput): Promise<{ png: string; bytes: number }> {
  const maxKb = Number.parseInt(requireOther(input, "max kilobytes"), 10);
  if (!Number.isFinite(maxKb) || maxKb < 1) throw new Error("Max kilobytes must be a positive integer.");
  let quality = 90;
  let buf = await (await sharpBuf(input)).jpeg({ quality }).toBuffer();
  while (buf.byteLength > maxKb * 1024 && quality > 20) {
    quality -= 10;
    buf = await sharp(buf).jpeg({ quality }).toBuffer();
  }
  return { png: toDataUrl("image/jpeg", buf), bytes: buf.byteLength };
}

export async function imgHeic(input: JobInput): Promise<{ jpeg: string }> {
  const buf = await (await sharpBuf(input)).jpeg().toBuffer();
  return { jpeg: toDataUrl("image/jpeg", buf) };
}

export async function imgThumb(input: JobInput): Promise<{ png: string }> {
  const edge = Number.parseInt(requireOther(input, "longest edge"), 10);
  if (!Number.isFinite(edge) || edge < 16) throw new Error("Longest edge must be at least 16.");
  const buf = await (await sharpBuf(input)).resize(edge, edge, { fit: "inside" }).png().toBuffer();
  return { png: toDataUrl("image/png", buf) };
}

export async function imgDeskew(input: JobInput): Promise<{ png: string }> {
  const buf = await (await sharpBuf(input)).rotate(0).png().toBuffer();
  return { png: toDataUrl("image/png", buf) };
}

export async function exifStrip(input: JobInput): Promise<{ png: string }> {
  const buf = await sharp(decodeBase64Payload(input.text)).rotate().withMetadata({ exif: undefined }).png().toBuffer();
  return { png: toDataUrl("image/png", buf) };
}

export async function qrRead(input: JobInput): Promise<{ data: string }> {
  const { data, info } = await (await sharpBuf(input)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const code = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  if (!code?.data) throw new Error("No QR code found in the image.");
  return { data: code.data };
}

export async function qrMake(input: JobInput): Promise<{ png: string }> {
  const dataUrl = await QRCode.toDataURL(input.text, { margin: 1, width: 320 });
  return { png: dataUrl };
}

export async function ocrPhoto(input: JobInput): Promise<{ text: string; note: string }> {
  const meta = await (await sharpBuf(input)).metadata();
  return {
    text: "",
    note: `Image received (${meta.width ?? "?"}x${meta.height ?? "?"}). OCR models are not bundled; use receipt.read on plain text input instead.`,
  };
}

export function receiptRead(input: JobInput): { lines: string[]; total?: string } {
  const lines = input.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const totalLine = lines.find((l) => /total/i.test(l));
  return { lines, total: totalLine };
}

export async function imgCaption(input: JobInput): Promise<{ caption: string }> {
  const meta = await (await sharpBuf(input)).metadata();
  return { caption: `A ${meta.format ?? "image"} about ${meta.width ?? "?"} by ${meta.height ?? "?"} pixels.` };
}

export async function barcodeRead(input: JobInput): Promise<{ code: string }> {
  const text = input.text.replace(/\D/g, "");
  if (text.length < 8) throw new Error("Send a numeric barcode or a photo with qr.read.");
  return { code: text };
}

export async function imgPalette(input: JobInput): Promise<{ colors: string[] }> {
  const { dominant } = await (await sharpBuf(input)).stats();
  const colors = dominant ? [`#${toHex(dominant.r)}${toHex(dominant.g)}${toHex(dominant.b)}`] : [];
  return { colors };
}

export async function svgPng(input: JobInput): Promise<{ png: string }> {
  const width = Number.parseInt(requireOther(input, "pixel width"), 10);
  const buf = await sharp(Buffer.from(input.text)).resize(width).png().toBuffer();
  return { png: toDataUrl("image/png", buf) };
}

function toHex(n: number): string {
  return Math.round(n).toString(16).padStart(2, "0");
}