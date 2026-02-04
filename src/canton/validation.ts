// Canton x402 SDK -- Input Validation

/**
 * Validate a Canton party ID format.
 * Expected format: `alias::1220<64 hex chars>`
 */
export function isValidPartyId(id: string): boolean {
  if (!id || typeof id !== "string") return false;
  const parts = id.split("::");
  if (parts.length !== 2) return false;
  const [alias, fingerprint] = parts;
  if (!alias || alias.length === 0) return false;
  if (!fingerprint || !fingerprint.startsWith("1220")) return false;
  const hexPart = fingerprint.slice(4);
  if (hexPart.length !== 64) return false;
  return /^[0-9a-f]+$/.test(hexPart);
}

/**
 * Validate a payment amount string.
 * Must be a positive decimal number, optionally bounded by a max.
 */
export function isValidAmount(
  amount: string,
  opts?: { max?: number },
): boolean {
  if (!amount || typeof amount !== "string") return false;
  const num = parseFloat(amount);
  if (isNaN(num) || num <= 0) return false;
  if (!isFinite(num)) return false;
  if (opts?.max !== undefined && num > opts.max) return false;
  return true;
}

/**
 * Validate a resource ID.
 * Max length 2048, only printable ASCII characters.
 */
export function isValidResourceId(id: string): boolean {
  if (!id || typeof id !== "string") return false;
  if (id.length > 2048) return false;
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7E]+$/.test(id);
}
