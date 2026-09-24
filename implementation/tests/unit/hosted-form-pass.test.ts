import { hostedFormAuthorizePass as platformPass } from "@edtp/platform-api/http/wallet-initiated.controllers.js";
import { WalletInitiatedClaims } from "@edtp/platform-api/modules/issuances/wallet-initiated-claims.js";
import { describe, expect, it } from "vitest";
import {
  hostedFormAuthorizePass as gatewayPass,
  hostedFormGate,
} from "../../apps/test-gateway/src/hosted-form-gate.js";

/**
 * Wallet-initiated issuance through the hosted form: the gate in front of the engine's
 * authorization endpoint, the pass that opens it, and the claims held in between.
 *
 * The engine's authorization endpoint mints a code for any browser that arrives, so the gate is the
 * only thing that makes the form mandatory. Each refusal below is a way round the form.
 */

const SECRET = "s".repeat(40);
const FORM = "https://edtp-pid.example.test/";
const REQUEST = "urn:7b1d1c2e-9a3f-4a55-8a0e-0f1f0e7b9c11";
const config = {
  GATEWAY_HOSTED_FORM_URL: FORM,
  GATEWAY_HOSTED_FORM_AUTHORIZE_SECRET: SECRET,
  GATEWAY_HOSTED_FORM_TENANTS: ["pid-1"],
};
const authorize = (tenant: string, query: string) => `/issuers/${tenant}/authorize?${query}`;

describe("the pass", () => {
  it("is computed identically by the platform and the gateway", () => {
    expect(gatewayPass(SECRET, "pid-1", REQUEST)).toBe(platformPass(SECRET, "pid-1", REQUEST));
  });

  it("binds the tenant and the request: one pass opens one authorization request", () => {
    const pass = platformPass(SECRET, "pid-1", REQUEST);
    expect(platformPass(SECRET, "rpi-1", REQUEST)).not.toBe(pass);
    expect(platformPass(SECRET, "pid-1", "urn:00000000-0000-4000-8000-000000000000")).not.toBe(
      pass,
    );
  });
});

describe("the gate at a hosted-form tenant's authorization endpoint", () => {
  it("sends a browser without a pass to the form, with the request and client only", () => {
    const gate = hostedFormGate(
      config,
      "GET",
      authorize("pid-1", `client_id=eudiw-abca&request_uri=${encodeURIComponent(REQUEST)}`),
    );
    expect(gate.kind).toBe("redirect");
    if (gate.kind !== "redirect") return;
    const location = new URL(gate.location);
    expect(location.origin + location.pathname).toBe(FORM);
    expect(Object.fromEntries(location.searchParams)).toEqual({
      tenant: "pid-1",
      request_uri: REQUEST,
      client_id: "eudiw-abca",
    });
  });

  it("lets a valid pass through to the engine, and removes it", () => {
    const pass = platformPass(SECRET, "pid-1", REQUEST);
    const gate = hostedFormGate(
      config,
      "GET",
      authorize(
        "pid-1",
        `client_id=eudiw-abca&request_uri=${encodeURIComponent(REQUEST)}&edtp_pass=${pass}`,
      ),
    );
    expect(gate.kind).toBe("pass");
    if (gate.kind !== "pass") return;
    expect(gate.forwardUrl).not.toContain("edtp_pass");
    expect(gate.forwardUrl).toContain(encodeURIComponent(REQUEST));
  });

  it("sends a forged or borrowed pass back to the form", () => {
    const forged = hostedFormGate(
      config,
      "GET",
      authorize(
        "pid-1",
        `request_uri=${encodeURIComponent(REQUEST)}&edtp_pass=${"A".repeat(43)}`,
      ),
    );
    const borrowed = hostedFormGate(
      config,
      "GET",
      authorize(
        "pid-1",
        `request_uri=${encodeURIComponent(REQUEST)}&edtp_pass=${platformPass(SECRET, "pid-1", "urn:other")}`,
      ),
    );
    expect(forged.kind).toBe("redirect");
    expect(borrowed.kind).toBe("redirect");
  });

  it("refuses an authorization request with no request_uri", () => {
    expect(hostedFormGate(config, "GET", authorize("pid-1", "client_id=x")).kind).toBe(
      "refuse",
    );
  });

  it("leaves other tenants, other methods and an unconfigured gateway alone", () => {
    const query = `request_uri=${encodeURIComponent(REQUEST)}`;
    expect(hostedFormGate(config, "GET", authorize("rpi-1", query)).kind).toBe("none");
    expect(hostedFormGate(config, "POST", authorize("pid-1", query)).kind).toBe("none");
    expect(
      hostedFormGate(
        { GATEWAY_HOSTED_FORM_TENANTS: ["pid-1"] },
        "GET",
        authorize("pid-1", query),
      ).kind,
    ).toBe("none");
  });
});

describe("claims held between the form and the engine", () => {
  const entry = (expiresAt: Date) => ({
    tenantId: "t",
    issuanceId: "i",
    engineTenantRef: "pid-1",
    claims: { family_name: "Synthetic" },
    expiresAt,
  });

  it("are handed over once, then gone", () => {
    const store = new WalletInitiatedClaims(() => new Date("2026-09-24T10:00:00Z"));
    expect(store.hold(REQUEST, entry(new Date("2026-09-24T10:05:00Z")))).toBe(true);
    expect(store.take("pid-1", REQUEST)?.claims).toEqual({ family_name: "Synthetic" });
    expect(store.take("pid-1", REQUEST)).toBeUndefined();
  });

  it("refuse a second hold for the same request, and are scoped to the engine tenant", () => {
    const store = new WalletInitiatedClaims(() => new Date("2026-09-24T10:00:00Z"));
    store.hold(REQUEST, entry(new Date("2026-09-24T10:05:00Z")));
    expect(store.hold(REQUEST, entry(new Date("2026-09-24T10:05:00Z")))).toBe(false);
    expect(store.take("rpi-1", REQUEST)).toBeUndefined();
  });

  it("are forgotten when the transaction's lifetime ends", () => {
    let now = new Date("2026-09-24T10:00:00Z");
    const store = new WalletInitiatedClaims(() => now);
    store.hold(REQUEST, entry(new Date("2026-09-24T10:05:00Z")));
    now = new Date("2026-09-24T10:05:01Z");
    expect(store.size).toBe(0);
    expect(store.take("pid-1", REQUEST)).toBeUndefined();
  });
});
