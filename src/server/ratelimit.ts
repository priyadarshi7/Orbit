/**
 * Rate limiting behind a small interface, so the in-memory implementation can be replaced by Redis
 * (shared across instances) without touching the routes.
 */
export type Take = { ok: true } | { ok: false; retryAfterMs: number };

export interface RateLimiter {
  /** Spends one request from `key`'s allowance of `perMin` requests per minute. */
  take(key: string, perMin: number): Take;
}

interface Bucket {
  tokens: number;
  at: number;
}

/** Token bucket: a full allowance up front, refilled continuously, so short bursts are fine but a sustained rate is capped. */
export class TokenBucketLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 20_000,
  ) {}

  take(key: string, perMin: number): Take {
    const t = this.now();
    const refillPerMs = perMin / 60_000;
    const b = this.buckets.get(key) ?? { tokens: perMin, at: t };
    b.tokens = Math.min(perMin, b.tokens + (t - b.at) * refillPerMs);
    b.at = t;
    let out: Take = { ok: true };
    if (b.tokens >= 1) b.tokens -= 1;
    else out = { ok: false, retryAfterMs: Math.ceil((1 - b.tokens) / refillPerMs) };
    this.buckets.delete(key); // re-insert so the Map stays in recency order
    this.buckets.set(key, b);
    if (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    return out;
  }
}

/** Caps how many answers one user can have streaming at once (each can fan out to many model calls). */
export class ConcurrencyGate {
  private readonly active = new Map<string, number>();

  /** Returns a release function, or null when the user is at the cap. */
  acquire(key: string, max: number): (() => void) | null {
    const n = this.active.get(key) ?? 0;
    if (n >= max) return null;
    this.active.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.active.get(key) ?? 1) - 1;
      if (left <= 0) this.active.delete(key);
      else this.active.set(key, left);
    };
  }
}
