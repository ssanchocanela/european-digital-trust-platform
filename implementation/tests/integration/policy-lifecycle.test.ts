import { newCorrelationId } from "@edtp/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../support/harness.js";
import { type SeededTenant, seedTenant } from "../support/seed.js";

/**
 * Policy versioning and validation through the service layer.
 *
 * Two properties: a published version is **immutable**, and a version that would over-ask is
 * refused with 422 at publication — the earliest of the three over-asking checks, before any
 * customer traffic and before any User sees the Wallet warning `EW-DM-44-027` (`RPRC_21`)
 * describes.
 */
let harness: Harness;
let seeded: SeededTenant;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  // Guarded: if `beforeAll` failed, the harness is undefined and an unguarded close would
  // mask the real cause with a TypeError.
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  // No published version: this suite drives publication itself.
  seeded = await seedTenant(harness, { publishPolicy: false });
});

const baseVersion = {
  purpose: [{ lang: "en", value: "Confirm the customer is an adult" }],
  credentialRequirements: [
    { credentialType: "urn:eudi:pid:1", acceptedFormats: ["dc+sd-jwt" as const] },
  ],
  requestedClaims: [{ path: ["birthdate"] }],
  resultPolicy: {
    kind: "DERIVED_CLAIMS" as const,
    derivations: [
      {
        name: "AgeAtLeast" as const,
        sourcePath: ["birthdate"],
        minimumAgeYears: 18,
        outputClaim: "over_18",
      },
    ],
  },
};

describe("policy versioning", () => {
  it("numbers versions monotonically from 1", async () => {
    const { policies } = harness.deps.services;
    const first = await policies.createVersion({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      ...baseVersion,
    });
    const second = await policies.createVersion({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      ...baseVersion,
    });
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(first.status).toBe("DRAFT");
  });

  it("refuses to create a presentation against a draft-only policy", async () => {
    await harness.deps.services.policies.createVersion({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      ...baseVersion,
    });

    // A draft has not been validated for use, so it is never resolvable by default.
    await expect(
      harness.deps.services.presentations.create({
        tenantId: seeded.tenantId,
        policyId: seeded.policyId,
        businessReference: "order-draft",
        correlationId: newCorrelationId(),
      }),
    ).rejects.toMatchObject({ code: "no_published_policy_version" });
  });

  it("publishes a draft and then refuses to publish it again", async () => {
    const { policies } = harness.deps.services;
    await policies.createVersion({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      ...baseVersion,
    });

    await policies.publishVersion(seeded.tenantId, seeded.policyId, 1);
    // The compare-and-set on `status = 'DRAFT'` makes a second publish a conflict rather than
    // a silent no-op that both callers read as success.
    await expect(
      policies.publishVersion(seeded.tenantId, seeded.policyId, 1),
    ).rejects.toMatchObject({ code: "policy_version_not_draft" });
  });

  it("uses the latest published version by default and honours an explicit one", async () => {
    const { policies, presentations } = harness.deps.services;
    await policies.createVersion({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      ...baseVersion,
      publish: true,
    });
    await policies.createVersion({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      ...baseVersion,
      purpose: [{ lang: "en", value: "Confirm the customer is at least 21" }],
      resultPolicy: {
        kind: "DERIVED_CLAIMS",
        derivations: [
          {
            name: "AgeAtLeast",
            sourcePath: ["birthdate"],
            minimumAgeYears: 21,
            outputClaim: "over_21",
          },
        ],
      },
      publish: true,
    });

    const latest = await presentations.create({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      businessReference: "order-latest",
      correlationId: newCorrelationId(),
    });
    expect(latest.policyVersion).toBe(2);

    const pinned = await presentations.create({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      policyVersion: 1,
      businessReference: "order-pinned",
      correlationId: newCorrelationId(),
    });
    expect(pinned.policyVersion).toBe(1);
  });

  it("keeps an in-flight transaction on the version it started with", async () => {
    const { policies, presentations } = harness.deps.services;
    await policies.createVersion({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      ...baseVersion,
      publish: true,
    });

    const created = await presentations.create({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      businessReference: "order-snapshot",
      correlationId: newCorrelationId(),
    });
    expect(created.policyVersion).toBe(1);

    // A new version is published mid-flight. The in-flight transaction must settle under the
    // version it snapshotted, not the new one.
    await policies.createVersion({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      ...baseVersion,
      resultPolicy: {
        kind: "DERIVED_CLAIMS",
        derivations: [
          {
            name: "AgeAtLeast",
            sourcePath: ["birthdate"],
            minimumAgeYears: 99,
            outputClaim: "over_99",
          },
        ],
      },
      publish: true,
    });

    harness.verifier.settleVerified("engine-session-1", { birthdate: "1990-05-17" });
    const settled = await presentations.get(
      seeded.tenantId,
      created.presentationId,
      newCorrelationId(),
    );
    expect(settled.policyVersion).toBe(1);
    expect(settled.result?.claims).toEqual({ over_18: true });
  });

  it("stores a published version immutably — there is no code path to edit it", async () => {
    const { policies } = harness.deps.services;
    await policies.createVersion({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      ...baseVersion,
      publish: true,
    });

    const before = await harness.deps.repositories.policies.findVersion(
      seeded.tenantId,
      seeded.policyId,
      1,
    );
    // Publishing a further version leaves version 1 byte-identical.
    await policies.createVersion({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      ...baseVersion,
      publish: true,
    });
    const after = await harness.deps.repositories.policies.findVersion(
      seeded.tenantId,
      seeded.policyId,
      1,
    );
    expect(after).toEqual(before);
  });
});

describe("validation at publication", () => {
  it("refuses a version requesting a claim outside the registered attributes", async () => {
    try {
      await harness.deps.services.policies.createVersion({
        tenantId: seeded.tenantId,
        policyId: seeded.policyId,
        ...baseVersion,
        requestedClaims: [{ path: ["birthdate"] }, { path: ["portrait"] }],
        resultPolicy: {
          kind: "VERIFIED_CLAIMS",
          allowedClaims: [["birthdate"], ["portrait"]],
        },
      });
      throw new Error("expected the policy version to be refused");
    } catch (error) {
      const platformError = error as {
        kind: string;
        code: string;
        details: { path?: string }[];
      };
      // HTTP 422 with the offending path named, so the integrator can fix it in one attempt.
      expect(platformError.kind).toBe("UNPROCESSABLE");
      expect(platformError.code).toBe("policy_version_invalid");
      expect(platformError.details.some((d) => d.path === "portrait")).toBe(true);
    }
  });

  it("accepts a nested claim under a registered parent", async () => {
    await harness.reset();
    const nested = await seedTenant(harness, {
      publishPolicy: false,
      registeredClaims: [["address"]],
    });
    const version = await harness.deps.services.policies.createVersion({
      tenantId: nested.tenantId,
      policyId: nested.policyId,
      purpose: baseVersion.purpose,
      credentialRequirements: baseVersion.credentialRequirements,
      // `address.locality` is within a registered `address`.
      requestedClaims: [{ path: ["address", "locality"] }],
      resultPolicy: {
        kind: "VERIFIED_CLAIMS",
        allowedClaims: [["address", "locality"]],
      },
      publish: true,
    });
    expect(version.status).toBe("PUBLISHED");
  });

  it("refuses a claim that is a prefix of a registered one", async () => {
    await harness.reset();
    const narrow = await seedTenant(harness, {
      publishPolicy: false,
      registeredClaims: [["address", "locality"]],
    });
    // Requesting `address` when only `address.locality` was registered asks for more.
    await expect(
      harness.deps.services.policies.createVersion({
        tenantId: narrow.tenantId,
        policyId: narrow.policyId,
        purpose: baseVersion.purpose,
        credentialRequirements: baseVersion.credentialRequirements,
        requestedClaims: [{ path: ["address"] }],
        resultPolicy: { kind: "VERIFIED_CLAIMS", allowedClaims: [["address"]] },
      }),
    ).rejects.toMatchObject({ code: "policy_version_invalid" });
  });

  it("refuses a result policy reading a claim the version does not request", async () => {
    await expect(
      harness.deps.services.policies.createVersion({
        tenantId: seeded.tenantId,
        policyId: seeded.policyId,
        ...baseVersion,
        resultPolicy: {
          kind: "VERIFIED_CLAIMS",
          allowedClaims: [["given_name"]],
        },
      }),
    ).rejects.toMatchObject({ code: "policy_version_invalid" });
  });
});

describe("V0 trust environment", () => {
  it("refuses to register a PRODUCTION Relying Party", async () => {
    const { registration } = harness.deps.services;
    const { tenant } = await registration.createTenant("Production Hopeful");
    const organisation = await registration.createOrganisation({
      tenantId: tenant.id,
      legalName: "Production Hopeful B.V.",
      memberState: "NL",
      isPublicSectorBody: false,
      officialIdentifiers: [
        { scheme: "http://data.europa.eu/eudi/id/EUID", value: "NLNHR.99999999" },
      ],
    });

    // V0 supports TEST only: production registration, certificates and Registrar
    // interactions are not simulated, and the legal qualification of the hosted instance
    // profile is still open (question Q2).
    await expect(
      registration.createRelyingParty({
        tenantId: tenant.id,
        organisationId: organisation.id,
        registrarAssignedIdentifier: "NLNHR.99999999",
        registrar: "NL-Registrar",
        trustEnvironment: "PRODUCTION",
      }),
    ).rejects.toMatchObject({ code: "trust_environment_not_supported" });
  });
});
