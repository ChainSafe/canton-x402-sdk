// One call's body. Checked before payment, so a bad call is not charged.
//
// SPDX-License-Identifier: Apache-2.0

/** Text and base64 payloads; large enough for small images and short audio clips. */
export const MAX_TEXT = 3_000_000;

export interface JobInput {
  text: string;
  other?: string;
}

export function readInput(body: unknown, needsOther: boolean): JobInput | { error: string } {
  if (body === null || typeof body !== "object") {
    return { error: "Send a JSON object with text." };
  }
  const record = body as { text?: unknown; other?: unknown };
  if (typeof record.text !== "string" || record.text.length === 0) {
    return { error: "text is required." };
  }
  if (record.text.length > MAX_TEXT) {
    return { error: "text is longer than one call allows." };
  }
  if (record.other !== undefined && typeof record.other !== "string") {
    return { error: "other must be a string." };
  }
  if (typeof record.other === "string" && record.other.length > MAX_TEXT) {
    return { error: "other is longer than one call allows." };
  }
  if (needsOther && (record.other === undefined || record.other.length === 0)) {
    return { error: "other is required for this tool." };
  }
  return record.other === undefined ? { text: record.text } : { text: record.text, other: record.other };
}
