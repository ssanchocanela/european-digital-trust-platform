import { clientKey, RateLimiter } from "@edtp/shared";
import { describe, expect, it } from "vitest";

/** The per-client limits of the demonstration environment's public processes (ADR 0010 §3). */
describe("RateLimiter", () => {
  it("allows up to the limit in a window, then refuses with a Retry-After", () => {
    let now = 0;
    const l = new RateLimiter({ max: 3, windowMs: 60_000 }, () => now);
    expect([1, 2, 3].map(() => l.take("a").allowed)).toEqual([true, true, true]);
    now = 15_000;
    const refused = l.take("a");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(45);
  });

  it("counts each client separately, and starts afresh after the window", () => {
    let now = 0;
    const l = new RateLimiter({ max: 1, windowMs: 1_000 }, () => now);
    expect(l.take("a").allowed).toBe(true);
    expect(l.take("b").allowed).toBe(true);
    expect(l.take("a").allowed).toBe(false);
    now = 1_000;
    expect(l.take("a").allowed).toBe(true);
  });

  it("is off at zero", () => {
    const l = new RateLimiter({ max: 0, windowMs: 1_000 });
    for (let i = 0; i < 100; i++) expect(l.take("a").allowed).toBe(true);
  });

  it("stays bounded when addresses rotate", () => {
    const l = new RateLimiter({ max: 5, windowMs: 60_000 }, () => 0, 100);
    for (let i = 0; i < 10_000; i++) l.take(`ip-${i}`);
    // Internal size is private; a fresh key still works and nothing threw.
    expect(l.take("fresh").allowed).toBe(true);
    expect(
      (l as unknown as { windows: Map<string, unknown> }).windows.size,
    ).toBeLessThanOrEqual(100);
  });
});

describe("clientKey", () => {
  it("uses the edge's client address when present, else the socket's", () => {
    expect(clientKey({ "cf-connecting-ip": "203.0.113.7" }, "127.0.0.1")).toBe("203.0.113.7");
    expect(clientKey({}, "127.0.0.1")).toBe("127.0.0.1");
    expect(clientKey({ "cf-connecting-ip": "x".repeat(65) }, "10.0.0.1")).toBe("10.0.0.1");
  });
});
