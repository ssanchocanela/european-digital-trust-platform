import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { PlatformError } from "@edtp/shared";
import { describe, expect, it } from "vitest";
import { Logger } from "../../apps/platform-api/src/logging/logger.js";
import {
  CloudflareAccessVerifier,
  DevelopmentAccessIdentity,
} from "../../apps/platform-api/src/modules/sandbox/access-identity.js";

/**
 * The Access assertion check (ADR 0018 Decision 1), against a key set this test generates and serves
 * from a stub fetch. No test disables the signature check: the stand-in is the key, not the rule.
 */
const TEAM = "team.cloudflareaccess.com";
const AUD = "a".repeat(64);
const NOW = new Date("2026-11-14T10:00:00Z");

const pair = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const good = pair();
const other = pair();

const jwk = (key: KeyObject, kid: string) => ({
  ...key.export({ format: "jwk" }),
  kid,
  alg: "RS256",
});

function assertion(
  claims: Record<string, unknown>,
  options: { kid?: string; key?: KeyObject; alg?: string } = {},
): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const h = enc({ alg: options.alg ?? "RS256", kid: options.kid ?? "k1", typ: "JWT" });
  const p = enc(claims);
  const s = sign("sha256", Buffer.from(`${h}.${p}`), options.key ?? good.privateKey);
  return `${h}.${p}.${s.toString("base64url")}`;
}

const t = Math.floor(NOW.getTime() / 1000);
const valid = {
  iss: `https://${TEAM}`,
  aud: [AUD],
  email: "Ana@Example.TEST",
  iat: t - 10,
  nbf: t - 10,
  exp: t + 600,
  type: "app",
};

function verifier(keys = [jwk(good.publicKey, "k1")]) {
  const fetched: string[] = [];
  const fetchStub = (async (url: string) => {
    fetched.push(String(url));
    return new Response(JSON.stringify({ keys }), { status: 200 });
  }) as unknown as typeof fetch;
  const clock = { now: () => NOW };
  const v = new CloudflareAccessVerifier(TEAM, AUD, clock, new Logger("error"), fetchStub);
  return { v, fetched };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "accepted";
  } catch (e) {
    return e instanceof PlatformError ? e.code : String(e);
  }
};

describe("the Cloudflare Access assertion", () => {
  it("yields the normalised address of a valid assertion, from the team's key set", async () => {
    const { v, fetched } = verifier();
    expect(await v.verify(assertion(valid))).toEqual({ email: "ana@example.test" });
    expect(fetched).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
  });

  it("caches the key set", async () => {
    const { v, fetched } = verifier();
    await v.verify(assertion(valid));
    await v.verify(assertion(valid));
    expect(fetched).toHaveLength(1);
  });

  it.each([
    ["no assertion", undefined],
    ["not a JWT", "abc"],
    ["signed by another key", assertion(valid, { key: other.privateKey })],
    ["an unknown key id", assertion(valid, { kid: "k9" })],
    ["another algorithm", assertion(valid, { alg: "HS256" })],
    ["another issuer", assertion({ ...valid, iss: "https://evil.cloudflareaccess.com" })],
    ["another audience", assertion({ ...valid, aud: ["b".repeat(64)] })],
    ["expired", assertion({ ...valid, exp: t - 120 })],
    ["not yet valid", assertion({ ...valid, nbf: t + 600 })],
    ["no e-mail", assertion({ ...valid, email: undefined })],
    ["an e-mail that is not one", assertion({ ...valid, email: "not an address" })],
  ])("refuses %s", async (_name, value) => {
    const { v } = verifier();
    expect(await code(v.verify(value))).toBe("unauthenticated");
  });

  it("refuses everything when the key set cannot be fetched", async () => {
    const failing = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const v = new CloudflareAccessVerifier(
      TEAM,
      AUD,
      { now: () => NOW },
      new Logger("error"),
      failing,
    );
    expect(await code(v.verify(assertion(valid)))).toBe("unauthenticated");
  });

  it("accepts a team domain given with a scheme, as the same issuer", async () => {
    const fetchStub = (async () =>
      new Response(
        JSON.stringify({ keys: [jwk(good.publicKey, "k1")] }),
      )) as unknown as typeof fetch;
    const v = new CloudflareAccessVerifier(
      `https://${TEAM}/`,
      AUD,
      { now: () => NOW },
      new Logger("error"),
      fetchStub,
    );
    expect(await v.verify(assertion(valid))).toEqual({ email: "ana@example.test" });
  });
});

describe("the development identity (ADR 0018 Decision 7)", () => {
  it("is one fixed, normalised address, and refuses something that is not one", async () => {
    expect(await new DevelopmentAccessIdentity(" Dev@Example.test ").verify()).toEqual({
      email: "dev@example.test",
    });
    expect(() => new DevelopmentAccessIdentity("nobody")).toThrow();
  });
});
