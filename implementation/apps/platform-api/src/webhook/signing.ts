import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Outbound webhook signing.
 *
 * HMAC-SHA256 over `timestamp.body` with a per-service secret, carried in a header
 * alongside the timestamp. Binding the timestamp into the signed string is what makes the
 * timestamp meaningful: signing the body alone would let an attacker replay a captured
 * payload with a fresh timestamp, because the timestamp would not be covered.
 *
 * The engine's own outbound webhooks authenticate with a static credential and carry no
 * signature, no timestamp and no event id. This is the platform's own customer-facing
 * channel and is independent of that — see `docs/interop-findings.md` B4.
 */
export const SIGNATURE_HEADER = "x-edtp-signature";
export const TIMESTAMP_HEADER = "x-edtp-timestamp";
export const EVENT_ID_HEADER = "x-edtp-event-id";

/** Receivers should reject anything older than this. Documented for integrators. */
export const RECOMMENDED_TOLERANCE_SECONDS = 300;

export interface SignedPayload {
  readonly body: string;
  readonly signature: string;
  readonly timestamp: string;
  readonly eventId: string;
}

export const signWebhookPayload = (input: {
  readonly secret: string;
  readonly payload: unknown;
  readonly eventId: string;
  readonly at: Date;
}): SignedPayload => {
  const body = JSON.stringify(input.payload);
  const timestamp = Math.floor(input.at.getTime() / 1000).toString(10);
  const signature = createHmac("sha256", input.secret)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");
  return { body, signature: `sha256=${signature}`, timestamp, eventId: input.eventId };
};

/**
 * Verifies a signature the way a receiver should.
 *
 * Exported and tested so the documented verification recipe is the one the platform
 * actually produces, rather than a description that drifts from the implementation.
 */
export const verifyWebhookSignature = (input: {
  readonly secret: string;
  readonly body: string;
  readonly signature: string;
  readonly timestamp: string;
  readonly now: Date;
  readonly toleranceSeconds?: number;
}): boolean => {
  const tolerance = input.toleranceSeconds ?? RECOMMENDED_TOLERANCE_SECONDS;
  const sent = Number.parseInt(input.timestamp, 10);
  if (!Number.isFinite(sent)) return false;
  const ageSeconds = Math.abs(Math.floor(input.now.getTime() / 1000) - sent);
  if (ageSeconds > tolerance) return false;

  const expected = createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.body}`, "utf8")
    .digest("hex");
  const provided = input.signature.startsWith("sha256=")
    ? input.signature.slice("sha256=".length)
    : input.signature;
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"));
};

/** Exponential backoff with jitter, bounded by a maximum delay. */
export const backoffDelayMs = (attempt: number, baseMs = 1_000, maxMs = 60_000): number => {
  const exponential = Math.min(baseMs * 2 ** attempt, maxMs);
  // Full jitter: spreads simultaneous retries so a receiver coming back up is not hit by
  // every pending delivery at once.
  return Math.floor(exponential / 2 + Math.random() * (exponential / 2));
};
