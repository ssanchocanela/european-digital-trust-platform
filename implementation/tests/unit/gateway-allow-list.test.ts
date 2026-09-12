/**
 * The allow-list that stands between a public tunnel and the engine's Management API.
 *
 * This is the highest-consequence code in the web-interface workstream: the engine serves `/api/*` on
 * the **same port** as the wallet-facing Protocol API, so a hole here publishes
 * `POST /api/key-chain/import` and every tenant route to the internet behind one shared secret
 * (`CLAUDE.md` §6.20).
 *
 * The tests are written as an attacker would probe it, not as a caller would use it.
 */
import {
  ENGINE_RULES,
  isAllowed,
  NEGATIVE_PROBES,
  PLATFORM_RULES,
} from "@edtp/test-gateway/allow-list.js";
import { describe, expect, it } from "vitest";

const T = "11111111-1111-1111-1111-111111111111";
const S = "session-abc";

describe("the engine allow-list permits exactly what a wallet needs", () => {
  it("permits the wallet-facing protocol paths", () => {
    const allowed: readonly [string, string][] = [
      ["GET", `/.well-known/openid-credential-issuer/issuers/${T}`],
      ["GET", `/.well-known/oauth-authorization-server/issuers/${T}`],
      ["GET", `/.well-known/jwks.json/issuers/${T}`],
      ["GET", `/.well-known/oauth-authorization-server/issuers/${T}/chained-as`],
      ["GET", `/presentations/${S}/oid4vp/request`],
      ["POST", `/presentations/${S}/oid4vp/request`],
      ["GET", `/presentations/${S}/oid4vp/request/no-redirect`],
      ["POST", `/presentations/${S}/oid4vp`],
      ["GET", `/issuers/${T}/vci/credential-offers/${S}`],
      ["POST", `/issuers/${T}/vci/credential`],
      ["POST", `/issuers/${T}/vci/nonce`],
      ["GET", `/issuers/${T}/authorize`],
      ["POST", `/issuers/${T}/authorize/token`],
      ["GET", `/issuers/${T}/status-management/status-list/list-1`],
    ];
    for (const [method, path] of allowed) {
      expect(isAllowed(ENGINE_RULES, method, path), `${method} ${path}`).toBe(true);
    }
  });
});

describe("the engine allow-list refuses everything else", () => {
  it("refuses the Management API — the one that matters", () => {
    const refused = [
      "/api/key-chain/import",
      "/api/tenant",
      "/api/verifier/config",
      "/api/docs-json",
      "/api/oauth2/token",
      "/api/issuer/config",
    ];
    for (const path of refused) {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        expect(isAllowed(ENGINE_RULES, method, path), `${method} ${path}`).toBe(false);
      }
    }
  });

  it("refuses documentation, health, storage and the root", () => {
    for (const path of [
      "/",
      "/docs",
      "/docs-json",
      "/health",
      "/storage/key",
      "/favicon.ico",
    ]) {
      expect(isAllowed(ENGINE_RULES, "GET", path), path).toBe(false);
    }
  });

  it("refuses a method the route does not use", () => {
    // An allow-list that ignored the method would forward a DELETE to see what the engine did with it.
    expect(isAllowed(ENGINE_RULES, "DELETE", `/presentations/${S}/oid4vp`)).toBe(false);
    expect(isAllowed(ENGINE_RULES, "PUT", `/issuers/${T}/vci/credential`)).toBe(false);
    expect(isAllowed(ENGINE_RULES, "POST", `/.well-known/jwks.json/issuers/${T}`)).toBe(false);
  });

  it("is anchored, so a permitted path cannot be used as a prefix or a suffix", () => {
    // The classic unanchored-regex holes, both directions.
    for (const path of [
      `/presentations/${S}/oid4vp/../../api/tenant`,
      `/api/tenant/presentations/${S}/oid4vp`,
      `/presentations/${S}/oid4vp/extra`,
      `/x/presentations/${S}/oid4vp`,
      `/issuers/${T}/vci/credential/../../../api/key-chain`,
    ]) {
      expect(isAllowed(ENGINE_RULES, "POST", path), path).toBe(false);
    }
  });

  it("refuses an identifier containing a path separator", () => {
    // `ID` is deliberately not `.*`. If it were, one segment could swallow a whole path.
    expect(isAllowed(ENGINE_RULES, "POST", "/presentations/a/b/oid4vp")).toBe(false);
    expect(isAllowed(ENGINE_RULES, "GET", "/issuers/a/b/authorize")).toBe(false);
  });
});

describe("the platform allow-list is one route", () => {
  it("permits only the same-device return page", () => {
    expect(isAllowed(PLATFORM_RULES, "GET", `/v1/presentations/${T}/return`)).toBe(true);
    expect(PLATFORM_RULES).toHaveLength(1);
  });

  it("refuses management, enumeration and the API's own description", () => {
    for (const path of [
      "/v1/tenants",
      `/v1/tenants/${T}/rp-services`,
      "/v1/presentations",
      `/v1/presentations/${T}`,
      "/health",
      "/openapi",
    ]) {
      expect(isAllowed(PLATFORM_RULES, "GET", path), path).toBe(false);
    }
  });

  it("refuses a POST to the return route", () => {
    expect(isAllowed(PLATFORM_RULES, "POST", `/v1/presentations/${T}/return`)).toBe(false);
  });
});

describe("the negative probes are the ones that would be run", () => {
  it("every probe is genuinely refused by the list it targets", () => {
    // The probes and the rules live in one file so a carelessly added rule and the check that would
    // catch it are reviewed together. This asserts they have not drifted apart.
    for (const probe of NEGATIVE_PROBES) {
      const rules = probe.target === "engine" ? ENGINE_RULES : PLATFORM_RULES;
      expect(isAllowed(rules, "GET", probe.path), `${probe.target} ${probe.path}`).toBe(false);
      expect(isAllowed(rules, "POST", probe.path), `${probe.target} ${probe.path}`).toBe(false);
    }
  });

  it("covers the Management API, the docs, health, storage and the root", () => {
    const paths = NEGATIVE_PROBES.filter((p) => p.target === "engine").map((p) => p.path);
    expect(paths).toContain("/api/key-chain");
    expect(paths).toContain("/api/tenant");
    expect(paths).toContain("/health");
    expect(paths).toContain("/storage/x");
    expect(paths).toContain("/");
  });
});
