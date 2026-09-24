/**
 * A small per-key rate limiter for the demonstration environment's public processes (ADR 0010 §3).
 *
 * Fixed windows, in memory, one instance per process. Deliberately simple: it caps how much one client
 * can make the platform do. It is not a quota system, and a restart forgets it. The edge rule in
 * Cloudflare is the coarse layer in front; this is the fine one, per kind of operation.
 *
 * Memory is bounded: when the number of tracked keys reaches `maxKeys`, expired windows are swept, and
 * if that is not enough the oldest keys go. An attacker rotating addresses therefore evicts entries
 * instead of growing the process — in the worst case losing some counts, never exhausting memory.
 */
export interface RateLimitRule {
  /** Requests allowed per window, per key. `0` disables the rule. */
  readonly max: number;
  readonly windowMs: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Seconds until the window resets, for a `Retry-After` header. */
  readonly retryAfterSeconds: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly rule: RateLimitRule,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  take(key: string): RateLimitDecision {
    if (this.rule.max <= 0) return { allowed: true, retryAfterSeconds: 0 };
    const at = this.now();
    let w = this.windows.get(key);
    if (!w || at - w.start >= this.rule.windowMs) {
      if (!w && this.windows.size >= this.maxKeys) this.evict(at);
      w = { start: at, count: 0 };
      this.windows.set(key, w);
    }
    w.count += 1;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((w.start + this.rule.windowMs - at) / 1000),
    );
    return w.count <= this.rule.max
      ? { allowed: true, retryAfterSeconds: 0 }
      : { allowed: false, retryAfterSeconds };
  }

  private evict(at: number): void {
    for (const [k, w] of this.windows) {
      if (at - w.start >= this.rule.windowMs) this.windows.delete(k);
    }
    // Still full: drop the oldest insertions (a Map iterates in insertion order).
    for (const k of this.windows.keys()) {
      if (this.windows.size < this.maxKeys) break;
      this.windows.delete(k);
    }
  }
}

/**
 * The client address a request is counted under. Behind Cloudflare the socket peer is `cloudflared`,
 * so the edge's `CF-Connecting-IP` is the client. It is trusted because the demonstration VM has no
 * inbound path but the tunnel: nothing can reach these processes without passing Cloudflare, which
 * sets the header. A request with no such header (a local call) is counted under its socket address.
 */
export const clientKey = (
  headers: Readonly<Record<string, string | string[] | undefined>>,
  socketAddress: string | undefined,
): string => {
  const cf = headers["cf-connecting-ip"];
  const value = Array.isArray(cf) ? cf[0] : cf;
  return value && value.length <= 64 ? value : (socketAddress ?? "unknown");
};
