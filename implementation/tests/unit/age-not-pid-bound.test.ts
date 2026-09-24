import {
  applyResultPolicy,
  defaultRetentionPolicy,
  type IntendedUse,
  validatePolicyVersion,
} from "@edtp/domain";
import { asId } from "@edtp/shared";
import { describe, expect, it } from "vitest";

/**
 * Age verification must not be wired to the PID in the domain model.
 *
 * V0 derives age from the PID date of birth, because PID Rulebook v1.1 removed the
 * age-verification attributes following CIR 2024/2977 and the reference issuer advertises none.
 * But that is a **policy** choice, not a structural one: when a dedicated age attestation exists,
 * a policy must be able to target it with no domain change.
 *
 * These tests pin that, so a later "simplification" that hard-codes `urn:eudi:pid:1` or
 * `birthdate` into the domain fails here rather than silently narrowing what the platform can do.
 */
const at = new Date("2026-09-11T08:00:00Z");
const tenantId = asId<"TenantId">("22222222-2222-2222-2222-222222222222");
const serviceId = asId<"RelyingPartyServiceId">("33333333-3333-3333-3333-333333333333");

const intendedUse = (overrides: Partial<IntendedUse>): IntendedUse => ({
  id: asId<"IntendedUseId">("11111111-1111-1111-1111-111111111111"),
  tenantId,
  relyingPartyServiceId: serviceId,
  intendedUseIdentifier: "registrar-intended-use-1",
  purpose: [{ lang: "en", value: "Confirm the customer is an adult" }],
  privacyPolicyUris: [{ lang: "en", value: "https://verifier.example/privacy" }],
  registeredCredentials: [],
  validFrom: new Date("2026-01-01T00:00:00Z"),
  createdAt: at,
  ...overrides,
});

describe("a policy can target a dedicated age attestation", () => {
  it("validates an age policy against a hypothetical age-attestation credential type", () => {
    // A future dedicated attestation, carrying a pre-computed boolean rather than a birth date.
    // Nothing in the domain knows or cares that this is not a PID.
    const use = intendedUse({
      registeredCredentials: [
        {
          format: "dc+sd-jwt",
          vctValues: ["urn:example:age-verification:1"],
          claims: [["age_over_18"]],
        },
      ],
    });

    const result = validatePolicyVersion(
      {
        purpose: [{ lang: "en", value: "Confirm the customer is an adult" }],
        credentialRequirements: [
          { credentialType: "urn:example:age-verification:1", acceptedFormats: ["dc+sd-jwt"] },
        ],
        requestedClaims: [{ path: ["age_over_18"] }],
        // With a pre-computed attribute, minimisation happens at the source — which is the
        // general rule (ADR 0005 Decision 5, R1). Derivation is only needed where no such
        // attribute exists, as is the case for the PID today.
        resultPolicy: { kind: "VERIFIED_CLAIMS", allowedClaims: [["age_over_18"]] },
        retentionPolicy: defaultRetentionPolicy(),
      },
      { intendedUse: use, at },
    );

    expect(result.ok).toBe(true);
  });

  it("returns the pre-computed attribute directly, with no derivation involved", () => {
    const outcome = applyResultPolicy(
      { kind: "VERIFIED_CLAIMS", allowedClaims: [["age_over_18"]] },
      { age_over_18: true },
      at,
    );
    expect(outcome.claims).toEqual({ age_over_18: true });
    expect(outcome.satisfied).toBe(true);
  });

  it("derives from any source path, not only the PID's", () => {
    // `AgeAtLeast` takes a `sourcePath`. It has no knowledge of `birthdate`, of `urn:eudi:pid:1`,
    // or of any namespace — so an mDL, a national eID or a sector attestation works unchanged.
    const fromMdl = applyResultPolicy(
      {
        kind: "DERIVED_CLAIMS",
        derivations: [
          {
            name: "AgeAtLeast",
            sourcePath: ["org.iso.18013.5.1", "birth_date"],
            minimumAgeYears: 21,
            outputClaim: "over_21",
          },
        ],
      },
      { "org.iso.18013.5.1": { birth_date: "1990-05-17" } },
      at,
    );
    expect(fromMdl.claims).toEqual({ over_21: true });

    const fromCustom = applyResultPolicy(
      {
        kind: "DERIVED_CLAIMS",
        derivations: [
          {
            name: "AgeAtLeast",
            sourcePath: ["subject", "dateOfBirth"],
            minimumAgeYears: 18,
            outputClaim: "over_18",
          },
        ],
      },
      { subject: { dateOfBirth: "2010-01-01" } },
      at,
    );
    expect(fromCustom.claims).toEqual({ over_18: false });
  });

  it("supports an mdoc age attestation with its own namespace", () => {
    const use = intendedUse({
      registeredCredentials: [
        {
          format: "mso_mdoc",
          doctype: "org.example.age.1",
          claims: [["org.example.age.1", "age_over_18"]],
        },
      ],
    });

    const result = validatePolicyVersion(
      {
        purpose: [{ lang: "en", value: "Confirm the customer is an adult" }],
        credentialRequirements: [
          { credentialType: "org.example.age.1", acceptedFormats: ["mso_mdoc"] },
        ],
        requestedClaims: [{ path: ["org.example.age.1", "age_over_18"] }],
        resultPolicy: {
          kind: "VERIFIED_CLAIMS",
          allowedClaims: [["org.example.age.1", "age_over_18"]],
        },
        retentionPolicy: defaultRetentionPolicy(),
      },
      { intendedUse: use, at },
    );

    expect(result.ok).toBe(true);
  });

  it("has no PID-specific identifier anywhere in the domain package", async () => {
    // The structural guarantee. If a later change hard-codes the PID type or a PID attribute name
    // into the domain, this fails — which is the point.
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");

    const walk = async (dir: string, out: string[] = []): Promise<string[]> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === "dist" || entry.name === "node_modules") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, out);
        else if (entry.name.endsWith(".ts")) out.push(full);
      }
      return out;
    };

    const domainSrc = join(__dirname, "..", "..", "packages", "domain", "src");
    const forbidden = ["urn:eudi:pid", "eu.europa.ec.eudi.pid", "age_over_18", "age_over_"];

    for (const file of await walk(domainSrc)) {
      const raw = await readFile(file, "utf8");
      // Comments may discuss the PID and the removed age attributes — that context is valuable.
      // Code may not depend on them.
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const term of forbidden) {
        expect(code.includes(term), `${file} hard-codes '${term}'`).toBe(false);
      }
    }
  });
});
