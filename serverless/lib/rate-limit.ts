/**
 * Fixed-window counter in memory. On serverless it is per warm instance, so it
 * slows a burst on one instance rather than enforcing an exact global quota
 * (the n8n original had the same limitation).
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  check(key: string, limit: number, now: number = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.hits.size >= this.maxKeys) this.prune(now);
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    return { allowed: entry.count <= limit, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  }

  private prune(now: number): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
    while (this.hits.size >= this.maxKeys) {
      const oldest = this.hits.keys().next();
      if (oldest.done) break;
      this.hits.delete(oldest.value);
    }
  }
}
