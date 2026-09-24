/**
 * Path segments are input, and were the one kind that was not validated.
 *
 * `GET /v1/presentations/null` reached the repository and produced a failed SQL statement: a `500` for
 * a plain client error, with the whole query in the log. It was found when the operator console passed
 * a malformed id straight through — which is what any browser-facing client does, and why this is worth
 * a test rather than a fix and a shrug.
 */
import { assertUuidPathParam } from "@edtp/platform-api/http/auth.js";
import { PlatformError } from "@edtp/shared";
import { describe, expect, it } from "vitest";

const VALID = "1b14df95-a911-4476-ae1a-77906dd251e4";

describe("assertUuidPathParam", () => {
  it("accepts a UUID and returns it unchanged", () => {
    expect(assertUuidPathParam("presentationId", VALID)).toBe(VALID);
  });

  it("accepts upper case, because a UUID is case-insensitive", () => {
    expect(assertUuidPathParam("presentationId", VALID.toUpperCase())).toBe(
      VALID.toUpperCase(),
    );
  });

  it("refuses the values that actually reached the database", () => {
    // `null` and `undefined` arrive as literal strings from a client that interpolated a missing value,
    // which is how this was found.
    for (const bad of ["null", "undefined", "", "1", "not-a-uuid"]) {
      expect(() => assertUuidPathParam("presentationId", bad), bad).toThrow(PlatformError);
    }
  });

  it("refuses a value shaped like SQL or a path", () => {
    for (const bad of [
      "' OR 1=1 --",
      "../../etc/passwd",
      `${VALID} OR 1=1`,
      `${VALID}/extra`,
    ]) {
      expect(() => assertUuidPathParam("presentationId", bad), bad).toThrow(PlatformError);
    }
  });

  it("is a validation error, not an internal one", () => {
    // The point of the fix: the status changes from 500 to 400. A 500 tells a caller nothing and pages
    // whoever is on call for a mistyped id.
    try {
      assertUuidPathParam("presentationId", "null");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformError);
      const platformError = error as PlatformError;
      expect(platformError.kind).toBe("VALIDATION");
      expect(platformError.code).toBe("invalid_path_parameter");
    }
  });

  it("names the parameter and never echoes the value", () => {
    // An invalid value is attacker-supplied. Echoing it into a message that is logged and rendered is
    // how a reflected-content problem starts.
    try {
      assertUuidPathParam("presentationId", "<script>alert(1)</script>");
      expect.unreachable("should have thrown");
    } catch (error) {
      const serialised = JSON.stringify(error, Object.getOwnPropertyNames(error));
      expect(serialised).toContain("presentationId");
      expect(serialised).not.toContain("script");
    }
  });

  it("accepts any UUID version, so a future v7 identifier is not rejected", () => {
    // Version nibble 7, variant `8`. The platform issues v4 today; pinning the version would be a
    // gratuitous future break.
    expect(() =>
      assertUuidPathParam("id", "0191b2c3-d4e5-7f60-8a1b-2c3d4e5f6a7b"),
    ).not.toThrow();
  });
});
