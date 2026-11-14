import { describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/platform-api/src/config.js";

/** The sandbox's configuration guards (specification §11, ADR 0015 Decision 2). */
const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://localhost/x",
  PLATFORM_ADMIN_API_KEY: `admin_${"a".repeat(40)}`,
  ENGINE_BASE_URL: "http://engine.invalid",
  ENGINE_TENANT_CREDENTIALS: "t=c:s",
  PLATFORM_PUBLIC_URL: "https://platform.test",
};
const sandbox = {
  SANDBOX_PORTAL_SECRET: "p".repeat(40),
  SANDBOX_OPERATOR_TENANT_ID: "00000000-0000-4000-8000-000000000001",
  SANDBOX_SIGN_IN_POLICY_ID: "00000000-0000-4000-8000-000000000002",
  SANDBOX_PORTAL_PUBLIC_URL: "https://portal.sandbox.test",
  SANDBOX_PARTICIPANT_TRUST_SOURCES: "https://sandbox.test/lote/PIDProviders.jwt",
  PSEUDONYM_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
  SANDBOX_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  SANDBOX_ACCESS_AUDIENCE: "a".repeat(64),
};

describe("sandbox configuration", () => {
  it("is off by default and starts with a complete configuration", () => {
    expect(loadConfig(base).SANDBOX_PORTAL_SECRET).toBeUndefined();
    const config = loadConfig({ ...base, ...sandbox });
    expect(config.SANDBOX_PARTICIPANT_TRUST_SOURCES).toEqual([
      "https://sandbox.test/lote/PIDProviders.jwt",
    ]);
  });

  it("refuses the PRODUCTION trust environment", () => {
    expect(() =>
      loadConfig({ ...base, ...sandbox, SANDBOX_TRUST_ENVIRONMENT: "PRODUCTION" }),
    ).toThrow(/TEST trust environment only/);
  });

  it("refuses to start without the participants' trust sources, which the sign-in check needs", () => {
    expect(() =>
      loadConfig({ ...base, ...sandbox, SANDBOX_PARTICIPANT_TRUST_SOURCES: "" }),
    ).toThrow(/SANDBOX_PARTICIPANT_TRUST_SOURCES/);
  });

  it("refuses to start without the pseudonym key or the operator's ids", () => {
    const { PSEUDONYM_MASTER_KEY: _k, SANDBOX_SIGN_IN_POLICY_ID: _p, ...rest } = sandbox;
    expect(() => loadConfig({ ...base, ...rest })).toThrow(
      /SANDBOX_SIGN_IN_POLICY_ID, PSEUDONYM_MASTER_KEY/,
    );
  });

  it("refuses a short pseudonym key", () => {
    expect(() =>
      loadConfig({
        ...base,
        ...sandbox,
        PSEUDONYM_MASTER_KEY: Buffer.alloc(16).toString("base64"),
      }),
    ).toThrow(/at least 32 bytes/);
  });

  it("refuses a portal secret shared with another public process", () => {
    expect(() =>
      loadConfig({
        ...base,
        ...sandbox,
        HOSTED_VERIFIER_SECRET: sandbox.SANDBOX_PORTAL_SECRET,
      }),
    ).toThrow(/SANDBOX_PORTAL_SECRET must differ/);
  });

  it("needs Cloudflare Access's team domain and audience together, or a development identity (ADR 0018)", () => {
    const { SANDBOX_ACCESS_TEAM_DOMAIN: _t, SANDBOX_ACCESS_AUDIENCE: _a, ...none } = sandbox;
    expect(() => loadConfig({ ...base, ...none })).toThrow(/SANDBOX_ACCESS_TEAM_DOMAIN/);
    expect(() =>
      loadConfig({ ...base, ...none, SANDBOX_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" }),
    ).toThrow(/go together/);
    expect(
      loadConfig({ ...base, ...none, SANDBOX_ACCESS_DEV_IDENTITY: "dev@example.test" })
        .SANDBOX_ACCESS_DEV_IDENTITY,
    ).toBe("dev@example.test");
  });

  it("never runs the development identity beside the real Access check (ADR 0018 Decision 7)", () => {
    expect(() =>
      loadConfig({ ...base, ...sandbox, SANDBOX_ACCESS_DEV_IDENTITY: "dev@example.test" }),
    ).toThrow(/cannot be set together/);
  });

  it("refuses a team domain with a scheme, and an audience that is not a tag", () => {
    expect(() =>
      loadConfig({
        ...base,
        ...sandbox,
        SANDBOX_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      }),
    ).toThrow();
    expect(() =>
      loadConfig({ ...base, ...sandbox, SANDBOX_ACCESS_AUDIENCE: "short" }),
    ).toThrow();
  });
});
