import { describe, expect, it } from "vitest";
import { renderOperator } from "../../apps/demo-portal/src/page.js";
import { decideProfileRequest } from "../../apps/demo-portal/src/profile-request.js";

/**
 * The operator page's profile button (ADR 0010 §2). The portal only writes a request; these are the
 * conditions for writing one.
 */
const base = {
  profile: "fnmt-corpme",
  permission: "on",
  who: "op@example.test",
  allowed: ["generic", "fnmt-corpme"],
  sameOrigin: true,
  now: new Date("2026-09-24T19:00:00Z"),
};

describe("a profile request", () => {
  it("is written for a known profile, from this page, by an Access identity", () => {
    const d = decideProfileRequest(base);
    expect(d).toEqual({
      ok: true,
      request: {
        profile: "fnmt-corpme",
        by: "op@example.test",
        at: "2026-09-24T19:00:00.000Z",
      },
    });
  });

  it("needs the written-permission box for a client profile, not for generic", () => {
    expect(decideProfileRequest({ ...base, permission: undefined }).ok).toBe(false);
    expect(
      decideProfileRequest({ ...base, profile: "generic", permission: undefined }).ok,
    ).toBe(true);
  });

  it("is refused without Access, from another site, or for an unknown profile", () => {
    expect(decideProfileRequest({ ...base, who: undefined }).ok).toBe(false);
    expect(decideProfileRequest({ ...base, sameOrigin: false }).ok).toBe(false);
    expect(decideProfileRequest({ ...base, profile: "../../etc" }).ok).toBe(false);
  });
});

describe("the operator page", () => {
  it("offers the switch, shows what is pending, and keeps e-mails out of obfuscation", () => {
    const html = renderOperator({
      who: "op@example.test",
      profile: "genérico",
      clientProfileOn: false,
      links: [],
      profileState: {
        profiles: ["generic", "fnmt-corpme"],
        pending: { profile: "fnmt-corpme", by: "op@example.test", at: "x" },
      },
    });
    expect(html).toContain('<form method="post" action="operador"');
    expect(html).toContain("Tengo el permiso por escrito");
    expect(html).toContain("Solicitud pendiente");
    expect(html).toContain("<!--email_off-->op@example.test<!--/email_off-->");
  });
});
