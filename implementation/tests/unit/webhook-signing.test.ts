import { describe, expect, it } from "vitest";
import {
  backoffDelayMs,
  RECOMMENDED_TOLERANCE_SECONDS,
  signWebhookPayload,
  verifyWebhookSignature,
} from "../../apps/platform-api/src/webhook/signing.js";

/**
 * Outbound webhook signing.
 *
 * The point of interest is that the **timestamp is inside the signed string**. Signing the
 * body alone would leave the timestamp unprotected, so an attacker could replay a captured
 * payload with a fresh timestamp and the freshness check would pass.
 *
 * `verifyWebhookSignature` is exported and tested here so the documented verification
 * recipe is the one the platform actually produces, rather than prose that drifts from it.
 */
const secret = "a-per-service-secret-value";
const at = new Date("2026-09-11T08:00:00Z");
const payload = {
  event: "presentation.settled",
  presentationId: "p-1",
  result: { claims: { over_18: true } },
};

describe("signWebhookPayload", () => {
  it("produces a prefixed hex signature, a unix timestamp and the event id", () => {
    const signed = signWebhookPayload({ secret, payload, eventId: "e-1", at });
    expect(signed.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signed.timestamp).toBe("1789113600");
    expect(signed.eventId).toBe("e-1");
    expect(JSON.parse(signed.body)).toEqual(payload);
  });

  it("is deterministic for the same body, secret and timestamp", () => {
    const a = signWebhookPayload({ secret, payload, eventId: "e-1", at });
    const b = signWebhookPayload({ secret, payload, eventId: "e-1", at });
    // Retries resend the identical bytes, so the signature must be reproducible.
    expect(a.signature).toBe(b.signature);
  });

  it("changes when the timestamp changes, because the timestamp is signed", () => {
    const a = signWebhookPayload({ secret, payload, eventId: "e-1", at });
    const b = signWebhookPayload({
      secret,
      payload,
      eventId: "e-1",
      at: new Date(at.getTime() + 1_000),
    });
    expect(a.signature).not.toBe(b.signature);
  });
});

describe("verifyWebhookSignature", () => {
  const signed = signWebhookPayload({ secret, payload, eventId: "e-1", at });

  it("accepts a valid, fresh signature", () => {
    expect(
      verifyWebhookSignature({
        secret,
        body: signed.body,
        signature: signed.signature,
        timestamp: signed.timestamp,
        now: at,
      }),
    ).toBe(true);
  });

  it("accepts a signature without the sha256= prefix", () => {
    expect(
      verifyWebhookSignature({
        secret,
        body: signed.body,
        signature: signed.signature.replace("sha256=", ""),
        timestamp: signed.timestamp,
        now: at,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(
      verifyWebhookSignature({
        secret,
        body: signed.body.replace("true", "false"),
        signature: signed.signature,
        timestamp: signed.timestamp,
        now: at,
      }),
    ).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(
      verifyWebhookSignature({
        secret: "another-secret",
        body: signed.body,
        signature: signed.signature,
        timestamp: signed.timestamp,
        now: at,
      }),
    ).toBe(false);
  });

  it("rejects a replay with a fresh timestamp", () => {
    // The crux. An attacker who captured the payload and signature cannot make it look
    // current, because the timestamp they would have to change is covered by the signature.
    const later = new Date(at.getTime() + 60_000);
    expect(
      verifyWebhookSignature({
        secret,
        body: signed.body,
        signature: signed.signature,
        timestamp: Math.floor(later.getTime() / 1000).toString(10),
        now: later,
      }),
    ).toBe(false);
  });

  it("rejects a signature older than the tolerance", () => {
    const muchLater = new Date(at.getTime() + (RECOMMENDED_TOLERANCE_SECONDS + 10) * 1000);
    expect(
      verifyWebhookSignature({
        secret,
        body: signed.body,
        signature: signed.signature,
        timestamp: signed.timestamp,
        now: muchLater,
      }),
    ).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(
      verifyWebhookSignature({
        secret,
        body: signed.body,
        signature: signed.signature,
        timestamp: "not-a-number",
        now: at,
      }),
    ).toBe(false);
  });

  it("rejects a truncated signature rather than comparing a prefix", () => {
    expect(
      verifyWebhookSignature({
        secret,
        body: signed.body,
        signature: signed.signature.slice(0, 20),
        timestamp: signed.timestamp,
        now: at,
      }),
    ).toBe(false);
  });
});

describe("backoffDelayMs", () => {
  it("grows exponentially and stays within the cap", () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const delay = backoffDelayMs(attempt, 1_000, 60_000);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(60_000);
    }
    // Later attempts wait longer than the first, on average across the jitter band.
    const early = backoffDelayMs(0, 1_000, 60_000);
    const late = backoffDelayMs(6, 1_000, 60_000);
    expect(late).toBeGreaterThan(early);
  });

  it("applies jitter, so simultaneous retries do not synchronise", () => {
    const samples = new Set(Array.from({ length: 30 }, () => backoffDelayMs(5, 1_000, 60_000)));
    expect(samples.size).toBeGreaterThan(1);
  });
});
