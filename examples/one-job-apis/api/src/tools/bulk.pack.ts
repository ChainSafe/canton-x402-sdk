// Bulk prepaid credits on the gateway — purchased once over x402.
//
// SPDX-License-Identifier: Apache-2.0

import type { JobInput } from "../input.ts";

const NOTE =
  "Quota is credited on the gateway after this receipt. Ordinary job calls spend quota instead of paying each time.";

function grant(n: number) {
  return (_input: JobInput) => ({ granted: n, note: NOTE });
}

export const run25 = grant(25);
export const run100 = grant(100);
export const run500 = grant(500);