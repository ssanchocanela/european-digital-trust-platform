import { type CredentialType, narrowToDeclaredClaims } from "@edtp/domain";
import { assertSuppliedAttributesAllowed } from "@edtp/platform-api/modules/issuances/issuance.service.js";
import { OperatorFormConnector } from "@edtp/platform-api/modules/issuances/operator-form-connector.js";
import { PlatformError, redact } from "@edtp/shared";
import { describe, expect, it } from "vitest";

/**
 * The test PID issuer's form: the one authentic source that takes attribute values from the caller.
 *
 * It is the declared exception to "a subject reference, never attribute values", so most of what is
 * pinned here is where the exception stops: every other source refuses supplied values, this one
 * refuses outside TEST, and a value the policy fixes cannot be supplied over it.
 */

const connector = new OperatorFormConnector();

const PID_PATHS = [
  "family_name",
  "given_name",
  "birthdate",
  "place_of_birth.country",
  "place_of_birth.locality",
  "nationalities",
  "issuing_authority",
  "issuing_country",
];

const FIXED = { fixedClaims: { issuing_authority: "EDTP TEST", issuing_country: "ES" } };

const fetch = (suppliedAttributes: Record<string, unknown>, parameters = FIXED) =>
  connector.fetch({
    tenantId: "t",
    subjectReference: "operator-form-1",
    requestedClaimPaths: PID_PATHS,
    parameters,
    suppliedAttributes,
  });

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PlatformError);
  return JSON.stringify(error);
};

describe("OperatorFormConnector", () => {
  it("is a FIXTURE that declares it takes supplied attributes", () => {
    expect(connector.kind).toBe("FIXTURE");
    expect(connector.acceptsSuppliedAttributes).toBe(true);
  });

  it("returns the supplied values nested, with the policy's fixed claims", async () => {
    const attributes = await fetch({
      family_name: "TEST",
      given_name: "FORM",
      birthdate: "1990-01-01",
      "place_of_birth.country": "ES",
      nationalities: ["ES"],
    });
    expect(attributes).toEqual({
      family_name: "TEST",
      given_name: "FORM",
      birthdate: "1990-01-01",
      place_of_birth: { country: "ES" },
      nationalities: ["ES"],
      issuing_authority: "EDTP TEST",
      issuing_country: "ES",
    });
  });

  it("accepts nested input as well as dotted", async () => {
    const attributes = await fetch({ place_of_birth: { locality: "Madrid" } });
    expect(attributes).toMatchObject({ place_of_birth: { locality: "Madrid" } });
  });

  it("drops empty strings, so a blank optional field is absent rather than empty", async () => {
    const attributes = await fetch({ "place_of_birth.locality": "", family_name: "TEST" });
    expect(attributes).not.toHaveProperty("place_of_birth");
  });

  it("refuses an attribute the credential type does not declare, naming it without its value", async () => {
    const error = await refusal(fetch({ given_nme: "SECRET-VALUE" }));
    expect(error).toContain("subject_attribute_not_declared");
    expect(error).toContain("given_nme");
    expect(error).not.toContain("SECRET-VALUE");
  });

  it("refuses a value for a claim the policy fixes, rather than overriding either silently", async () => {
    const error = await refusal(fetch({ issuing_country: "FR" }));
    expect(error).toContain("subject_attribute_fixed_by_policy");
  });
});

describe("assertSuppliedAttributesAllowed", () => {
  const ordinary = { name: "fixture", kind: "FIXTURE" as const };
  const form = {
    name: "operator-form",
    kind: "FIXTURE" as const,
    acceptsSuppliedAttributes: true,
  };

  it("refuses supplied values for a source that takes a subject reference", () => {
    expect(() => assertSuppliedAttributesAllowed(ordinary, { a: 1 }, "TEST")).toThrow(
      /subjectAttributes|takes a subject reference/,
    );
  });

  it("lets an ordinary source through with no supplied values", () => {
    expect(() => assertSuppliedAttributesAllowed(ordinary, undefined, "TEST")).not.toThrow();
  });

  it("refuses the form source outside TEST", () => {
    expect(() => assertSuppliedAttributesAllowed(form, { a: 1 }, "PRODUCTION")).toThrow(/TEST/);
  });

  it("refuses a source that takes supplied values unless it is a FIXTURE", () => {
    expect(() =>
      assertSuppliedAttributesAllowed({ ...form, kind: "REAL" }, { a: 1 }, "TEST"),
    ).toThrow(/FIXTURE/);
  });

  it("refuses the form source with nothing supplied", () => {
    expect(() => assertSuppliedAttributesAllowed(form, undefined, "TEST")).toThrow(/none were/);
    expect(() => assertSuppliedAttributesAllowed(form, {}, "TEST")).toThrow(/none were/);
  });

  it("accepts the form source with values, in TEST", () => {
    expect(() => assertSuppliedAttributesAllowed(form, { a: 1 }, "TEST")).not.toThrow();
  });
});

describe("string[] claims", () => {
  const type = {
    claims: [
      {
        path: ["nationalities"],
        display: [{ lang: "en", value: "Nationalities" }],
        mandatory: true,
        valueType: "string[]",
      },
    ],
  } as unknown as CredentialType;

  it("accepts a non-empty array of strings", () => {
    expect(narrowToDeclaredClaims({ nationalities: ["ES", "PT"] }, type)).toEqual({
      nationalities: ["ES", "PT"],
    });
  });

  it.each([
    ["an empty array", []],
    ["a bare string", "ES"],
    ["an array with a non-string", ["ES", 1]],
    ["an array with an empty string", [""]],
  ])("refuses %s", (_label, value) => {
    expect(() => narrowToDeclaredClaims({ nationalities: value }, type)).toThrow(PlatformError);
  });
});

describe("redaction", () => {
  it("never logs supplied attributes or PID attributes", () => {
    const logged = JSON.stringify(
      redact({
        subjectAttributes: { family_name: "A" },
        place_of_birth: { country: "ES" },
        nationalities: ["ES"],
      }),
    );
    expect(logged).not.toContain('"A"');
    expect(logged).not.toContain("ES");
  });
});
