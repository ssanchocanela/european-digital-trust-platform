import type { VerificationPlan } from "@edtp/domain";
import { defaultRetentionPolicy, defaultTrustPolicy } from "@edtp/domain";
import {
  buildDcqlQuery,
  dcqlCredentialId,
  toEngineStatusCheckMode,
} from "@edtp/eudiplo-adapter";
import { describe, expect, it } from "vitest";

/**
 * DCQL construction — the only place in the platform where a protocol query is built.
 *
 * Claim paths pass through unchanged, because they are already OpenID4VP claims path
 * pointers (TS5 `Claim.path`, OpenID4VP §6.3 with §7.1 for `dc+sd-jwt` and §7.2 for
 * `mso_mdoc`). That identity is one of the reasons ADR 0005 Decision 1c models requested
 * claims as paths rather than as flat names.
 */
const plan = (overrides: Partial<VerificationPlan> = {}): VerificationPlan => ({
  policyId: "55555555-5555-5555-5555-555555555555",
  policyVersion: 1,
  purpose: [{ lang: "en", value: "Confirm the customer is an adult" }],
  credentialRequirement: {
    credentialType: "urn:eudi:pid:1",
    acceptedFormats: ["dc+sd-jwt"],
    vctValues: ["urn:eudi:pid:1"],
  },
  requestedClaims: [{ path: ["birthdate"] }],
  trustConstraints: defaultTrustPolicy(),
  resultTransformation: { kind: "VERIFIED_CLAIMS", allowedClaims: [["birthdate"]] },
  retentionInstructions: defaultRetentionPolicy(),
  relyingPartyContext: {
    relyingPartyIdentifier: "NLNHR.12345678",
    serviceIdentifier: "age-gate",
    serviceTradeName: "Example Age Gate",
    intendedUseIdentifier: "registrar-intended-use-1",
    accessKeyBindingRef: "key-chain-1",
    engineTenantRef: "engine-tenant-a",
  },
  ...overrides,
});

describe("buildDcqlQuery", () => {
  it("builds an SD-JWT VC query with vct_values", () => {
    const query = buildDcqlQuery(plan());
    expect(query.credentials).toHaveLength(1);
    const credential = query.credentials[0];
    expect(credential?.format).toBe("dc+sd-jwt");
    // OpenID4VP Annex B.3.5 defines the SD-JWT VC meta parameter.
    expect(credential?.meta).toEqual({ vct_values: ["urn:eudi:pid:1"] });
    expect(credential?.claims).toEqual([{ path: ["birthdate"] }]);
  });

  it("builds an mdoc query with meta.doctype_value", () => {
    // The engine reads `meta.doctype_value`; its v7.3.0 release fixed this field name to
    // match the schema it accepts. Getting it wrong produces a request no wallet can match.
    const query = buildDcqlQuery(
      plan({
        credentialRequirement: {
          credentialType: "eu.europa.ec.eudi.pid.1",
          acceptedFormats: ["mso_mdoc"],
          doctype: "eu.europa.ec.eudi.pid.1",
        },
        requestedClaims: [{ path: ["eu.europa.ec.eudi.pid.1", "birth_date"] }],
      }),
    );
    const credential = query.credentials[0];
    expect(credential?.format).toBe("mso_mdoc");
    expect(credential?.meta).toEqual({ doctype_value: "eu.europa.ec.eudi.pid.1" });
    expect(credential?.claims).toEqual([{ path: ["eu.europa.ec.eudi.pid.1", "birth_date"] }]);
  });

  it("emits one credential entry per accepted format so either can satisfy the request", () => {
    const query = buildDcqlQuery(
      plan({
        credentialRequirement: {
          credentialType: "urn:eudi:pid:1",
          acceptedFormats: ["dc+sd-jwt", "mso_mdoc"],
          vctValues: ["urn:eudi:pid:1"],
          doctype: "urn:eudi:pid:1",
        },
      }),
    );
    expect(query.credentials).toHaveLength(2);
    expect(query.credentials.map((c) => c.format)).toEqual(["dc+sd-jwt", "mso_mdoc"]);
    // Distinct ids, because the engine keys its per-credential outcome on them.
    expect(new Set(query.credentials.map((c) => c.id)).size).toBe(2);
  });

  it("passes nested and wildcard claim paths through unchanged", () => {
    const query = buildDcqlQuery(
      plan({
        requestedClaims: [
          { path: ["address", "locality"] },
          { path: ["nationalities", null] },
          { path: ["nationalities", 0] },
        ],
      }),
    );
    expect(query.credentials[0]?.claims).toEqual([
      { path: ["address", "locality"] },
      { path: ["nationalities", null] },
      { path: ["nationalities", 0] },
    ]);
  });

  it("refuses to build an SD-JWT VC query with no vct values", () => {
    expect(() =>
      buildDcqlQuery(
        plan({
          credentialRequirement: {
            credentialType: "urn:eudi:pid:1",
            acceptedFormats: ["dc+sd-jwt"],
          },
        }),
      ),
    ).toThrowError(/no vct values/i);
  });

  it("refuses to build an mdoc query with no document type", () => {
    expect(() =>
      buildDcqlQuery(
        plan({
          credentialRequirement: {
            credentialType: "x",
            acceptedFormats: ["mso_mdoc"],
          },
        }),
      ),
    ).toThrowError(/no document type/i);
  });
});

describe("dcqlCredentialId", () => {
  it("is stable for a credential type and carries nothing user-specific", () => {
    // The id travels to the wallet. A per-transaction value would be a correlation handle,
    // so it is derived only from the credential type.
    expect(dcqlCredentialId("urn:eudi:pid:1")).toBe(dcqlCredentialId("urn:eudi:pid:1"));
    expect(dcqlCredentialId("urn:eudi:pid:1")).toBe("urn-eudi-pid-1");
  });

  it("produces a usable id for an awkward credential type", () => {
    expect(dcqlCredentialId("!!!")).toBe("credential");
    expect(dcqlCredentialId("eu.europa.ec.eudi.pid.1")).toBe("eu-europa-ec-eudi-pid-1");
  });
});

describe("toEngineStatusCheckMode", () => {
  it("maps the platform mode to the engine's", () => {
    // V0 uses STRICT (fail-closed) because `AS-AP-07-023` (`VCR_13`) requires a documented
    // risk analysis before skipping revocation checking, and V0 has performed none.
    expect(toEngineStatusCheckMode("STRICT")).toBe("strict");
    expect(toEngineStatusCheckMode("BEST_EFFORT")).toBe("best_effort");
    expect(toEngineStatusCheckMode("DISABLED")).toBe("disabled");
  });
});
