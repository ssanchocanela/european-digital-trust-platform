/**
 * The console's escaping and its privacy boundary.
 *
 * Two things are worth a test rather than a comment. The console renders text a *customer* supplied —
 * a policy's purpose, a trade name, a business reference — so escaping is not theoretical. And the
 * result panel is where `AS-RP-01-002` (`OIA_16`) meets a web page: a panel that rendered anything the
 * API did not return would be the leak `CLAUDE.md` §5 forbids, and the easiest place to introduce one.
 */
import { escapeHtml, html, rawHtml, toHtmlString } from "@edtp/operator-console/html.js";
import { InteractionCache } from "@edtp/operator-console/interaction-cache.js";
import { statusPayload } from "@edtp/operator-console/views.js";
import { describe, expect, it } from "vitest";

describe("escaping", () => {
  it("escapes the five characters that matter in content and in quoted attributes", () => {
    expect(escapeHtml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
  });

  it("escapes interpolations by default", () => {
    const injected = '"><script>alert(1)</script>';
    const out = toHtmlString(html`<p title="${injected}">${injected}</p>`);
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("leaves already-safe markup alone, and only via rawHtml", () => {
    // `rawHtml(` is the single searchable escape hatch. If this test ever needs changing, the change
    // under review is "something new is being trusted".
    const out = toHtmlString(html`<div>${rawHtml("<b>bold</b>")}</div>`);
    expect(out).toBe("<div><b>bold</b></div>");
  });

  it("renders arrays and drops nullish values rather than printing them", () => {
    expect(toHtmlString(html`${[1, 2, 3]}`)).toBe("123");
    expect(toHtmlString(html`${null}${undefined}${false}`)).toBe("");
  });
});

describe("the status payload the poller consumes", () => {
  const base = {
    presentationId: "p-1",
    businessReference: "run-1",
    policyId: "pol-1",
    policyVersion: 2,
    expiresAt: "2026-09-11T12:00:00.000Z",
  };

  it("adds nothing the API did not return", () => {
    const payload = statusPayload({ ...base, status: "PENDING" });
    expect(Object.keys(payload).sort()).toEqual(
      ["failureCode", "resultHtml", "status", "terminal"].sort(),
    );
  });

  it("marks terminal states so the poller stops", () => {
    expect(statusPayload({ ...base, status: "VERIFIED" })["terminal"]).toBe(true);
    expect(statusPayload({ ...base, status: "FAILED" })["terminal"]).toBe(true);
    expect(statusPayload({ ...base, status: "PENDING" })["terminal"]).toBe(false);
  });

  it("escapes claim keys and values, which are attacker-influenced in the general case", () => {
    const payload = statusPayload({
      ...base,
      status: "VERIFIED",
      result: { claims: { "<img src=x onerror=alert(1)>": '"><script>alert(1)</script>' } },
    });
    const markup = String(payload["resultHtml"]);
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img");
  });

  it("summarises a structured claim rather than dumping it", () => {
    // A claim whose value is an object or array is reported by shape. Stringifying an object graph is
    // how a nested value nobody expected ends up on a screen and then in a screenshot.
    const payload = statusPayload({
      ...base,
      status: "VERIFIED",
      result: { claims: { address: { street: "x" }, names: ["a", "b"] } },
    });
    const markup = String(payload["resultHtml"]);
    expect(markup).toContain("{object}");
    expect(markup).toContain("[2 values]");
    expect(markup).not.toContain("street");
  });

  it("shows no result panel content when there is no result", () => {
    const markup = String(statusPayload({ ...base, status: "PENDING" })["resultHtml"]);
    expect(markup).toContain("No result yet");
  });
});

describe("the interaction cache", () => {
  // It exists because `GET /v1/presentations/{id}` does not return the interaction URI. It is the one
  // piece of state the console holds, so its bounds are worth asserting rather than trusting.
  it("returns what was stored, until it expires", () => {
    let now = 0;
    const cache = new InteractionCache(() => now);
    cache.set("p-1", { uri: "openid4vp://?a=1", type: "SAME_DEVICE" });

    expect(cache.get("p-1")?.uri).toBe("openid4vp://?a=1");
    now = 10 * 60 * 1_000 - 1;
    expect(cache.get("p-1")).toBeDefined();
    now = 10 * 60 * 1_000;
    expect(cache.get("p-1")).toBeUndefined();
  });

  it("is bounded, so a loop creating presentations cannot grow it without limit", () => {
    const cache = new InteractionCache(() => 0);
    for (let i = 0; i < 500; i += 1) {
      cache.set(`p-${i}`, { uri: `openid4vp://?i=${i}`, type: "QR" });
    }
    expect(cache.size).toBeLessThanOrEqual(200);
    // Oldest-first eviction: the most recent entry must survive, because that is the one a redirect is
    // about to render.
    expect(cache.get("p-499")).toBeDefined();
  });

  it("does not resurrect an expired entry", () => {
    let now = 0;
    const cache = new InteractionCache(() => now);
    cache.set("p-1", { uri: "openid4vp://?a=1", type: "QR" });
    now = 11 * 60 * 1_000;
    expect(cache.get("p-1")).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});
