// Decode a JWT header and payload. The signature is not checked.
//
// SPDX-License-Identifier: Apache-2.0

import type { JobInput } from "../input.ts";

export function run(input: JobInput): { header: unknown; payload: unknown; signatureChecked: false } | { error: string } {
  const parts = input.text.trim().split(".");
  if (parts.length < 2 || !parts[0] || !parts[1]) return { error: "A JWT here is header.payload.signature." };
  try {
    return {
      header: decodePart(parts[0]),
      payload: decodePart(parts[1]),
      signatureChecked: false,
    };
  } catch {
    return { error: "The header or payload is not base64url JSON." };
  }
}

function decodePart(part: string): unknown {
  const padded = part.replaceAll("-", "+").replaceAll("_", "/");
  const json = Buffer.from(padded, "base64").toString("utf8");
  return JSON.parse(json);
}
