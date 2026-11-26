// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import gTTS from "gtts";
import { parseBuffer } from "music-metadata";

import type { JobInput } from "../../input.ts";
import { decodeBase64Payload, toDataUrl } from "../helpers.ts";

export async function speechSay(input: JobInput): Promise<{ mp3: string }> {
  if (input.text.length > 500) throw new Error("Keep text at 500 characters or less.");
  const speech = new gTTS(input.text, "en");
  const buf: Buffer = await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = speech.stream();
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
  return { mp3: toDataUrl("audio/mpeg", buf) };
}

export async function speechText(input: JobInput): Promise<{ seconds: number; note: string }> {
  const meta = await parseBuffer(decodeBase64Payload(input.text), undefined, { duration: true });
  return {
    seconds: meta.format.duration ?? 0,
    note: "Speech-to-text models are not bundled. Duration is real; paste transcript text into receipt.read.",
  };
}

export async function speechSrt(input: JobInput): Promise<{ srt: string }> {
  const { seconds } = await speechText(input);
  return {
    srt: `1\n00:00:00,000 --> 00:00:${String(Math.floor(seconds)).padStart(2, "0")},000\n[transcript not bundled in demo]\n`,
  };
}

export async function speechTrim(input: JobInput): Promise<{ note: string }> {
  await parseBuffer(decodeBase64Payload(input.text));
  return { note: "Silence trimming needs ffmpeg in the worker image. Audio was accepted." };
}

export async function speechMp3(input: JobInput): Promise<{ mp3: string }> {
  const buf = decodeBase64Payload(input.text);
  return { mp3: toDataUrl("audio/mpeg", buf) };
}