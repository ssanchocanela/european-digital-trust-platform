/**
 * The signed hand-off to the public start page.
 *
 * This is the only part of the web interface that is publicly reachable, so its failure modes are the
 * ones worth pinning: a forged token, a stale one, and a token that could turn the page into an open
 * redirector.
 */
import {
  isPermittedInteractionUri,
  mintStartToken,
  START_TOKEN_TTL_SECONDS,
  verifyStartToken,
} from "@edtp/start-token";
import { describe, expect, it } from "vitest";

const SECRET = "a".repeat(48);
const OTHER_SECRET = "b".repeat(48);
const NOW = 1_789_000_000;
const URI =
  "openid4vp://?client_id=x509_hash%3Aabc&request_uri=https%3A%2F%2Fengine.test%2Freq%2F1";

describe("mintStartToken / verifyStartToken", () => {
  it("round-trips the interaction URI and the presentation id", () => {
    const token = mintStartToken(SECRET, { uri: URI, presentationId: "p-1", nowSeconds: NOW });
    const result = verifyStartToken(SECRET, token, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.uri).toBe(URI);
    expect(result.payload.presentationId).toBe("p-1");
    expect(result.payload.expiresAt).toBe(NOW + START_TOKEN_TTL_SECONDS);
  });

  it("refuses a token signed with a different secret", () => {
    // The whole point: a second deployment's console cannot start a wallet against this one.
    const token = mintStartToken(OTHER_SECRET, {
      uri: URI,
      presentationId: "p-1",
      nowSeconds: NOW,
    });
    expect(verifyStartToken(SECRET, token, NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses a tampered payload", () => {
    const token = mintStartToken(SECRET, { uri: URI, presentationId: "p-1", nowSeconds: NOW });
    const [, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        uri: "openid4vp://?client_id=attacker",
        presentationId: "p-1",
        expiresAt: NOW + 999,
        nonce: "n",
      }),
      "utf8",
    ).toString("base64url");

    expect(verifyStartToken(SECRET, `${forged}.${signature}`, NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("expires, and reports expiry separately from forgery", () => {
    // Separate reasons because they mean different things to an operator: "scan again" versus "that
    // token was not issued by this console". The public page shows neither distinction to a visitor.
    const token = mintStartToken(SECRET, { uri: URI, presentationId: "p-1", nowSeconds: NOW });
    expect(verifyStartToken(SECRET, token, NOW + START_TOKEN_TTL_SECONDS)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(verifyStartToken(SECRET, token, NOW + START_TOKEN_TTL_SECONDS - 1).ok).toBe(true);
  });

  it("gives every token a distinct nonce, so a reuse is detectable", () => {
    const first = mintStartToken(SECRET, { uri: URI, presentationId: "p-1", nowSeconds: NOW });
    const second = mintStartToken(SECRET, { uri: URI, presentationId: "p-1", nowSeconds: NOW });
    expect(first).not.toBe(second);

    const a = verifyStartToken(SECRET, first, NOW);
    const b = verifyStartToken(SECRET, second, NOW);
    expect(a.ok && b.ok && a.payload.nonce !== b.payload.nonce).toBe(true);
  });

  it("refuses malformed input without throwing", () => {
    for (const token of ["", "no-dot", "a.b.c", "!!!.!!!", ".", `${"x".repeat(40)}.y`]) {
      const result = verifyStartToken(SECRET, token, NOW);
      expect(result.ok, token).toBe(false);
    }
  });

  it("refuses a well-signed token whose payload is not an object", () => {
    // A signature proves provenance, not shape. Both are checked.
    const body = Buffer.from(JSON.stringify([1, 2, 3]), "utf8").toString("base64url");
    const token = mintStartToken(SECRET, { uri: URI, presentationId: "p", nowSeconds: NOW });
    const [, sig] = token.split(".");
    // Re-sign the array body so the signature is genuine and only the shape is wrong.
    const signed = verifyStartToken(SECRET, `${body}.${sig}`, NOW);
    expect(signed.ok).toBe(false);
  });
});

describe("isPermittedInteractionUri", () => {
  it("accepts wallet schemes", () => {
    expect(isPermittedInteractionUri("openid4vp://?x=1")).toBe(true);
    expect(isPermittedInteractionUri("eudi-openid4vp://?x=1")).toBe(true);
    expect(isPermittedInteractionUri("mdoc-openid4vp://?x=1")).toBe(true);
    expect(isPermittedInteractionUri("haip://?x=1")).toBe(true);
  });

  it("refuses http(s) and anything else", () => {
    // This is the control that keeps the public page from becoming an open redirector **that our own
    // signature vouches for** — a risk that only arises if a future change lets a token carry a URL.
    expect(isPermittedInteractionUri("https://evil.test/")).toBe(false);
    expect(isPermittedInteractionUri("http://evil.test/")).toBe(false);
    expect(isPermittedInteractionUri("javascript:alert(1)")).toBe(false);
    expect(isPermittedInteractionUri("data:text/html,<script>")).toBe(false);
    expect(isPermittedInteractionUri("not a uri")).toBe(false);
    expect(isPermittedInteractionUri("")).toBe(false);
  });
});
