import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertPayloadSatisfiesSchema } from "@edtp/platform-api/modules/issuances/payload-schema.js";
import { describe, expect, it } from "vitest";

/**
 * The test PID's data model: PID Rulebook v1.1, SD-JWT VC encoding (section 4.1), at
 * `eudi-doc-attestation-rulebooks-catalog` commit `36f8adcf`. The file is what
 * `scripts/upgrade-test-pid-type.mjs` sends; these tests pin the encoding rules the claim list
 * cannot carry and the schema must.
 */
const model = JSON.parse(
  readFileSync(
    join(__dirname, "..", "..", "scripts", "pid", "pid-rulebook-sd-jwt.json"),
    "utf8",
  ),
) as {
  claims: { path: string[]; mandatory: boolean }[];
  payloadSchema: Record<string, unknown>;
};
const VCT = "urn:eudi:pid:1";
const valid = {
  family_name: "PRUEBA",
  given_name: "FICTICIA",
  birthdate: "1990-01-01",
  place_of_birth: { country: "ES", locality: "Madrid" },
  nationalities: ["ES"],
  personal_administrative_number: "00000000T",
  issuing_authority: "FNMT-RCM (DEMO - TEST ONLY)",
  issuing_country: "ES",
  attestation_legal_category: "PID",
};
const check = (claims: Record<string, unknown>) => () =>
  assertPayloadSatisfiesSchema(model.payloadSchema, VCT, claims);

describe("PID Rulebook model", () => {
  it("uses the section 4.1 claim names, and omits the portrait", () => {
    const names = model.claims.map((c) => c.path.join("."));
    for (const n of [
      "birthdate",
      "nationalities",
      "place_of_birth.region",
      "birth_family_name",
      "address.house_number",
      "date_of_issuance",
      "attestation_legal_category",
    ]) {
      expect(names).toContain(n);
    }
    for (const n of ["birth_date", "nationality", "birth_place", "gender", "picture"]) {
      expect(names).not.toContain(n);
    }
  });

  it("accepts a valid PID", () => {
    expect(check(valid)).not.toThrow();
  });

  it("requires the country of birth and the ID number, stricter than the Rulebook", () => {
    // Section 4.1 accepts any one of country, region or locality; this provider requires country.
    expect(check({ ...valid, place_of_birth: { locality: "Madrid" } })).toThrow();
    const { personal_administrative_number: _pan, ...noPan } = valid;
    expect(check(noPan)).toThrow();
    const mandatory = model.claims.filter((c) => c.mandatory).map((c) => c.path.join("."));
    expect(mandatory).toContain("place_of_birth.country");
    expect(mandatory).toContain("personal_administrative_number");
  });

  it("refuses a missing place of birth", () => {
    expect(check({ ...valid, place_of_birth: {} })).toThrow();
    const { place_of_birth: _omitted, ...without } = valid;
    expect(check(without)).toThrow();
  });

  it("holds the encodings: alpha-2 codes, dates, the sex code list", () => {
    expect(check({ ...valid, nationalities: ["QU"] })).not.toThrow();
    expect(check({ ...valid, nationalities: ["ESP"] })).toThrow();
    expect(check({ ...valid, birthdate: "01-01-1990" })).toThrow();
    expect(check({ ...valid, sex: 9 })).not.toThrow();
    expect(check({ ...valid, sex: 7 })).toThrow();
    expect(check({ ...valid, address: { country: "es" } })).toThrow();
    expect(check({ ...valid, phone_number: "+34600000000" })).not.toThrow();
    expect(check({ ...valid, phone_number: "600 000 000" })).toThrow();
  });
});
