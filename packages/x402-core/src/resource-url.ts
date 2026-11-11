// Binding a payment to the resource it buys.
//
// The resource a payer echoes is not signed — `PaymentPayload.resource` and the
// requirements it carries are both free for the payer to write — so comparing
// them tells you a client is consistent, not that the payment was minted for
// this route. What binds is a stamp inside the prepared transaction, under
// `x402.resourceUrl`, which the payer signs along with the rest of the transfer.
//
// The stamp is the SHA-256 of the URL rather than the URL. Canton's ledger is
// readable, and a plaintext URL would publish which API an agent buys from to
// every stakeholder and to Scan; the hash keeps the binding and not the
// subject. An upstream convention, not a field of the registered scheme spec,
// which names only `x402.memo`.
//
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

/** Lowercase-hex SHA-256 of the exact UTF-8 URL. Unsalted, so it is reproducible. */
export function hashResourceUrl(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("hex");
}

/**
 * Does an `x402.resourceUrl` stamp bind this transfer to `expectedUrl`?
 *
 * Accepts the hash and the plaintext URL. Clients deployed before the hashed
 * form stamp the URL itself, and refusing them would refuse payments that are
 * correctly bound — the privacy of the hash is the stamping client's to choose,
 * not something a verifier can impose after the fact.
 *
 * Call it only when a stamp is present. An absent stamp is not a mismatch: it
 * is a payment that carries no binding, which the caller decides what to do
 * with.
 */
export function resourceUrlMatchesStamp(stamp: string, expectedUrl: string): boolean {
  return stamp === expectedUrl || stamp === hashResourceUrl(expectedUrl);
}
