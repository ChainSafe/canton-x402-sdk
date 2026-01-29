// Canton x402 SDK -- Nonce Store (replay protection)

/**
 * In-memory nonce store with TTL-based eviction.
 * Prevents replay of x402 payment nonces.
 */
export class NonceStore {
  private nonces = new Map<string, number>();
  private ttlMs: number;

  constructor(ttlMs = 3600_000) {
    this.ttlMs = ttlMs;
  }

  hasNonce(nonce: string): boolean {
    this.cleanup();
    return this.nonces.has(nonce);
  }

  addNonce(nonce: string): void {
    this.nonces.set(nonce, Date.now());
  }

  cleanup(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [nonce, ts] of this.nonces) {
      if (ts < cutoff) this.nonces.delete(nonce);
    }
  }

  get size(): number {
    return this.nonces.size;
  }
}
