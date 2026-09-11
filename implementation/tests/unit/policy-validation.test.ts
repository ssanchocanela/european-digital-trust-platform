import {
  defaultRetentionPolicy,
  type IntendedUse,
  type PresentationPolicyVersion,
  registeredClaimsFor,
  validatePolicyVersion,
} from "@edtp/domain";
import { asId } from "@edtp/shared";
import { describe, expect, it } from "vitest";

/**
 * Policy validation against the registered intended use.
 *
 * This is the earliest of the three over-asking checks. `EW-DM-44-027` (`RPRC_21`) makes the
 * Wallet warn the User that the Relying Party "is requesting more information than it has
 * registered"; catching it here means a 422 at publication instead, before any customer
 * traffic and before any User sees that warning.
 */
const intendedUse = (overrides: Partial<IntendedUse> = {}): IntendedUse => ({
  id: asId<"IntendedUseId">("11111111-1111-1111-1111-111111111111"),
  tenantId: asId<"TenantId">("22222222-2222-2222-2222-222222222222"),
  relyingPartyServiceId: asId<"RelyingPartyServiceId">("33333333-3333-3333-3333-333333333333"),
  intendedUseIdentifier: "registrar-intended-use-1",
  purpose: [{ lang: "en", value: "Confirm the customer is an adult" }],
  privacyPolicyUris: [{ lang: "en", value: "https://verifier.example/privacy" }],
  registeredCredentials: [
    {
      format: "dc+sd-jwt",
      vctValues: ["urn:eudi:pid:1"],
      claims: [["birthdate"]],
    },
  ],
  validFrom: new Date("2026-01-01T00:00:00Z"),
  createdAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
});

type Candidate = Pick<
  PresentationPolicyVersion,
  "purpose" | "credentialRequirements" | "requestedClaims" | "resultPolicy" | "retentionPolicy"
>;

const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  purpose: [{ lang: "en", value: "Confirm the customer is an adult" }],
  credentialRequirements: [
    { credentialType: "urn:eudi:pid:1", acceptedFormats: ["dc+sd-jwt"] },
  ],
  requestedClaims: [{ path: ["birthdate"] }],
  resultPolicy: {
    kind: "DERIVED_CLAIMS",
    derivations: [
      {
        name: "AgeAtLeast",
        sourcePath: ["birthdate"],
        minimumAgeYears: 18,
        outputClaim: "over_18",
      },
    ],
  },
  retentionPolicy: defaultRetentionPolicy(),
  ...overrides,
});

const at = new Date("2026-09-11T08:00:00Z");

describe("validatePolicyVersion", () => {
  it("accepts the V0 age-check policy", () => {
    const result = validatePolicyVersion(candidate(), { intendedUse: intendedUse(), at });
    expect(result.ok).toBe(true);
  });

  it("refuses a claim outside the registered attributes, naming the path", () => {
    const result = validatePolicyVersion(
      candidate({
        requestedClaims: [{ path: ["birthdate"] }, { path: ["portrait"] }],
        resultPolicy: {
          kind: "VERIFIED_CLAIMS",
          allowedClaims: [["birthdate"], ["portrait"]],
        },
      }),
      { intendedUse: intendedUse(), at },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.error.map((d) => d.code);
    expect(codes).toContain("claim_not_registered");
    expect(result.error.some((d) => d.path === "portrait")).toBe(true);
  });

  it("refuses a credential type that is not registered for the intended use", () => {
    const result = validatePolicyVersion(
      candidate({
        credentialRequirements: [
          { credentialType: "urn:eudi:mdl:1", acceptedFormats: ["dc+sd-jwt"] },
        ],
      }),
      { intendedUse: intendedUse(), at },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.map((d) => d.code)).toContain("credential_not_registered");
  });

  it("refuses a format that is not registered, even for a registered credential type", () => {
    const result = validatePolicyVersion(
      candidate({
        credentialRequirements: [
          { credentialType: "urn:eudi:pid:1", acceptedFormats: ["mso_mdoc"] },
        ],
      }),
      { intendedUse: intendedUse(), at },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.map((d) => d.code)).toContain("credential_not_registered");
  });

  it("refuses more than one credential requirement in V0", () => {
    const result = validatePolicyVersion(
      candidate({
        credentialRequirements: [
          { credentialType: "urn:eudi:pid:1", acceptedFormats: ["dc+sd-jwt"] },
          { credentialType: "urn:eudi:pid:1", acceptedFormats: ["mso_mdoc"] },
        ],
      }),
      { intendedUse: intendedUse(), at },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.map((d) => d.code)).toContain("single_credential_requirement");
  });

  it("requires a localised purpose, because the Wallet displays it (RPA_10)", () => {
    const noPurpose = validatePolicyVersion(candidate({ purpose: [] }), {
      intendedUse: intendedUse(),
      at,
    });
    expect(noPurpose.ok).toBe(false);
    if (!noPurpose.ok) {
      expect(noPurpose.error.map((d) => d.code)).toContain("purpose_required");
    }

    const noEnglish = validatePolicyVersion(
      candidate({ purpose: [{ lang: "nl", value: "Leeftijd bevestigen" }] }),
      { intendedUse: intendedUse(), at },
    );
    expect(noEnglish.ok).toBe(false);
    if (!noEnglish.ok) {
      expect(noEnglish.error.map((d) => d.code)).toContain("purpose_missing_en");
    }
  });

  it("refuses publication against an intended use with no privacy policy", () => {
    const result = validatePolicyVersion(candidate(), {
      intendedUse: intendedUse({ privacyPolicyUris: [] }),
      at,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.map((d) => d.code)).toContain("privacy_policy_required");
  });

  it("refuses an intended use that has been revoked or has expired", () => {
    const result = validatePolicyVersion(candidate(), {
      intendedUse: intendedUse({ revokedAt: new Date("2026-06-01T00:00:00Z") }),
      at,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.map((d) => d.code)).toContain("intended_use_revoked");
  });

  it("refuses an intended use that is not yet valid", () => {
    const result = validatePolicyVersion(candidate(), {
      intendedUse: intendedUse({ validFrom: new Date("2027-01-01T00:00:00Z") }),
      at,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.map((d) => d.code)).toContain("intended_use_not_yet_valid");
  });

  it("refuses a result policy that reads a claim the version does not request", () => {
    const result = validatePolicyVersion(
      candidate({
        requestedClaims: [{ path: ["birthdate"] }],
        resultPolicy: {
          kind: "DERIVED_CLAIMS",
          derivations: [
            {
              name: "ClaimPresence",
              // Not requested, so the wallet would never disclose it.
              sourcePath: ["address", "locality"],
              outputClaim: "has_locality",
            },
          ],
        },
      }),
      { intendedUse: intendedUse(), at },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.map((d) => d.code)).toContain("result_policy_reads_unrequested_claim");
  });

  it("refuses a transaction lifetime below the engine's minimum session TTL", () => {
    const result = validatePolicyVersion(
      candidate({
        retentionPolicy: { transactionLifetimeSeconds: 30, resultRetentionSeconds: 3_600 },
      }),
      { intendedUse: intendedUse(), at },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.map((d) => d.code)).toContain("transaction_lifetime_too_short");
  });

  it("reports every violation in one pass", () => {
    const result = validatePolicyVersion(
      candidate({ purpose: [], requestedClaims: [{ path: ["portrait"] }] }),
      { intendedUse: intendedUse(), at },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // One request should be enough to learn everything that is wrong.
    expect(result.error.length).toBeGreaterThan(2);
  });
});

describe("registeredClaimsFor", () => {
  it("only contributes claims from credentials matching both type and format", () => {
    const use = intendedUse({
      registeredCredentials: [
        { format: "dc+sd-jwt", vctValues: ["urn:eudi:pid:1"], claims: [["birthdate"]] },
        {
          format: "mso_mdoc",
          doctype: "eu.europa.ec.eudi.pid.1",
          claims: [["eu.europa.ec.eudi.pid.1", "portrait"]],
        },
      ],
    });
    const claims = registeredClaimsFor(use, {
      credentialType: "urn:eudi:pid:1",
      acceptedFormats: ["dc+sd-jwt"],
    });
    // The mdoc credential registers `portrait`, but this requirement is SD-JWT VC only, so
    // `portrait` must not become requestable through it.
    expect(claims).toEqual([["birthdate"]]);
  });
});
