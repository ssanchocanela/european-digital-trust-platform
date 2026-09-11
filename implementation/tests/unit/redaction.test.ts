import { DENIED_KEYS, findDeniedKeysIn, isDeniedKey, REDACTED, redact } from "@edtp/shared";
import { describe, expect, it } from "vitest";
import { Logger } from "../../apps/platform-api/src/logging/logger.js";

/**
 * The log redaction deny-list.
 *
 * **This suite is the enforcement mechanism, not a description of one.** The V0 plan
 * requires a deny-list test that fails the build if payload-like fields reach the logs, and
 * ARF `AS-RP-01-002` (`OIA_16`) forbids communicating the `AS-AP-10-064` (`ISSU_35`) unique
 * elements onward at all — a log line is onward communication.
 */
describe("isDeniedKey", () => {
  it("denies presentation and issuance content keys", () => {
    for (const key of [
      "vp_token",
      "verifiedClaims",
      "presentedClaims",
      "credentials",
      "credentialPayload",
      "claims",
      "disclosures",
      "mdoc",
      "deviceResponse",
    ]) {
      expect(isDeniedKey(key), key).toBe(true);
    }
  });

  it("denies the ISSU_35 unique elements", () => {
    // Per-attribute salts, attribute hashes, the revocation index, the device-binding public
    // key and the provider signature value.
    for (const key of [
      "_sd",
      "sd_hash",
      "salt",
      "cnf",
      "deviceKey",
      "statusListIndex",
      "signature",
    ]) {
      expect(isDeniedKey(key), key).toBe(true);
    }
  });

  it("denies PID attributes", () => {
    for (const key of [
      "birthdate",
      "birth_date",
      "portrait",
      "picture",
      "family_name",
      "given_name",
    ]) {
      expect(isDeniedKey(key), key).toBe(true);
    }
  });

  it("denies secrets and key material", () => {
    for (const key of [
      "x5c",
      "privateKey",
      "private_jwk",
      "responseEncryptionPrivateJwk",
      "client_secret",
      "password",
      "authorization",
      "apiKey",
      "access_token",
    ]) {
      expect(isDeniedKey(key), key).toBe(true);
    }
  });

  it("is case-insensitive and matches structural markers as substrings", () => {
    expect(isDeniedKey("VerifiedClaims")).toBe(true);
    expect(isDeniedKey("WEBHOOK_SECRET")).toBe(true);
    expect(isDeniedKey("issuanceThumbprint")).toBe(true);
    expect(isDeniedKey("attributeSalt")).toBe(true);
  });

  it("allows the safe identifiers the platform needs to log", () => {
    for (const key of [
      "presentationId",
      "tenantId",
      "correlationId",
      "policyId",
      "policyVersion",
      "status",
      "failureCode",
      "interactionType",
    ]) {
      expect(isDeniedKey(key), key).toBe(false);
    }
  });
});

describe("redact", () => {
  it("replaces denied values at every depth", () => {
    const redacted = redact({
      presentationId: "p-1",
      verifiedClaims: { birthdate: "1990-05-17" },
      nested: { deep: { salt: "abc", safe: "keep" } },
    }) as Record<string, unknown>;

    expect(redacted.presentationId).toBe("p-1");
    expect(redacted.verifiedClaims).toBe(REDACTED);
    const deep = (redacted.nested as { deep: Record<string, unknown> }).deep;
    expect(deep.salt).toBe(REDACTED);
    expect(deep.safe).toBe("keep");
  });

  it("redacts inside arrays", () => {
    const redacted = redact({ items: [{ birthdate: "1990-05-17" }, { ok: 1 }] }) as {
      items: Record<string, unknown>[];
    };
    expect(redacted.items[0]?.birthdate).toBe(REDACTED);
    expect(redacted.items[1]?.ok).toBe(1);
  });

  it("refuses to serialise an object of unknown shape rather than risk a getter", () => {
    class Credential {
      get birthdate() {
        return "1990-05-17";
      }
    }
    // A class instance could expose anything through a getter, so it is replaced wholesale
    // instead of walked field by field.
    expect(redact({ credential: new Credential() })).toEqual({ credential: REDACTED });
    expect(redact({ other: new Credential() })).toEqual({ other: "[UNSERIALISABLE]" });
  });

  it("replaces binary values and maps rather than dumping them", () => {
    expect(redact({ buf: Buffer.from("secret") })).toEqual({ buf: "[UNSERIALISABLE]" });
    expect(redact({ m: new Map([["a", 1]]) })).toEqual({ m: "[UNSERIALISABLE]" });
  });

  it("truncates pathologically deep structures instead of recursing without bound", () => {
    let deep: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };
    expect(JSON.stringify(redact(deep))).toContain("[TRUNCATED]");
  });

  it("keeps dates and errors in a safe form", () => {
    const redacted = redact({
      at: new Date("2026-09-11T08:00:00Z"),
      err: new Error("boom"),
    }) as Record<string, unknown>;
    expect(redacted.at).toBe("2026-09-11T08:00:00.000Z");
    expect(redacted.err).toEqual({ name: "Error", message: "boom" });
  });
});

describe("the logger cannot emit a denied key", () => {
  const capture = () => {
    const lines: string[] = [];
    return { lines, logger: new Logger("debug", { write: (l) => lines.push(l) }) };
  };

  it("redacts every denied field in an emitted line", () => {
    const { lines, logger } = capture();
    logger.info("presentation settled", {
      presentationId: "p-1",
      tenantId: "t-1",
      verifiedClaims: { birthdate: "1990-05-17", portrait: "<jpeg>" },
      vp_token: "eyJ...",
      salt: "abcdef",
    });

    expect(lines).toHaveLength(1);
    const line = lines[0] as string;

    // No denied value survives.
    expect(line).not.toContain("1990-05-17");
    expect(line).not.toContain("<jpeg>");
    expect(line).not.toContain("eyJ...");
    expect(line).not.toContain("abcdef");
    // The safe identifiers do.
    expect(line).toContain("p-1");
    expect(line).toContain("presentation settled");
  });

  it("redacts context inherited from a child logger", () => {
    const { lines, logger } = capture();
    // A denied key set once on a child logger would otherwise leak into every later line.
    logger.child({ birthdate: "1990-05-17" }).info("hello");
    expect(lines[0]).not.toContain("1990-05-17");
  });

  it("emits a line with no denied key names carrying values", () => {
    const { lines, logger } = capture();
    logger.error("engine failure", {
      correlationId: "c-1",
      failureCode: "trust_chain_not_trusted",
      credentials: [{ payload: "…" }],
    });
    // An independent check on the emitted text: any denied key present must have been
    // reduced to the redaction marker.
    const line = lines[0] as string;
    for (const key of findDeniedKeysIn(line)) {
      const pattern = new RegExp(
        `"${key}"\\s*:\\s*"${REDACTED.replace(/[[\]]/g, "\\$&")}"`,
        "i",
      );
      expect(pattern.test(line), `${key} was emitted with a value`).toBe(true);
    }
  });

  it("keeps the deny-list non-empty, so the mechanism cannot be disabled by emptying it", () => {
    expect(DENIED_KEYS.length).toBeGreaterThan(30);
  });
});
