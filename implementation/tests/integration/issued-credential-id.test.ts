import { defaultRetentionPolicy } from "@edtp/domain";
import { asId, PlatformError, type TenantId } from "@edtp/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../support/harness.js";

/**
 * Every read of an issued transaction names its credential (`issuedCredentialId`), not only the read
 * that settled it — otherwise a client that missed that one read could never revoke what it issued.
 * Found while building the sandbox's PID revocation (S5).
 */
let harness: Harness;

beforeAll(async () => {
  harness = await createHarness({ fakeIssuer: true });
});
afterAll(async () => {
  await harness?.close();
});
beforeEach(async () => {
  await harness.reset();
});

/** A TEST provider with one operator-form policy, through the real writes. */
async function seedIssuer(name: string): Promise<{ tenantId: TenantId; policyId: string }> {
  const { tenant } = await harness.deps.services.registration.createTenant(name);
  const organisation = await harness.deps.services.registration.createOrganisation({
    tenantId: tenant.id,
    legalName: `${name} B.V.`,
    memberState: "NL",
    isPublicSectorBody: false,
    officialIdentifiers: [
      { scheme: "http://data.europa.eu/eudi/id/EUID", value: `NL.TEST.${name}` },
    ],
  });
  const repository = harness.deps.repositories.issuance;
  const at = harness.clock.now();
  const provider = await repository.createAttestationProvider({
    tenantId: tenant.id,
    organisationId: organisation.id,
    registrarAssignedIdentifier: `TEST-${name}`,
    trustEnvironment: "TEST",
    at,
  });
  await repository.provisionAttestationProvider({
    tenantId: tenant.id,
    attestationProviderId: provider.id,
    engineTenantRef: `engine-${name.toLowerCase()}`,
    signingKeyBindingRef: "signing-key",
  });
  const type = await repository.createCredentialType({
    tenantId: tenant.id,
    type: {
      attestationProviderId: provider.id,
      name: "Test card",
      format: "dc+sd-jwt",
      vct: "urn:edtp:test:card:1",
      rulebook: {
        identifier: "urn:edtp:test:rulebook:card",
        version: "1",
        anchorSource: "RULEBOOK_ONLY",
      },
      claims: [
        {
          path: ["name"],
          display: [{ lang: "en", value: "Name" }],
          mandatory: true,
          valueType: "string",
        },
      ],
      display: [{ lang: "en", value: "Test card" }],
      validitySeconds: 86_400,
      statusMechanism: "TOKEN_STATUS_LIST",
      requiresKeyBinding: true,
    },
    at,
  });
  const policy = await repository.createPolicy({
    tenantId: tenant.id,
    credentialTypeId: type.id,
    name: "Card",
    at,
  });
  await repository.createVersion({
    tenantId: tenant.id,
    policyId: policy.id,
    body: {
      credentialTypeId: type.id,
      purpose: [{ lang: "en", value: "Issue a test card" }],
      eligibilityRule: { evaluator: "AlwaysEligible", parameters: {} },
      authenticSource: { connector: "operator-form", parameters: {} },
      holderBinding: "KEY_BOUND",
      flow: "PRE_AUTHORIZED_CODE",
      credentialValiditySeconds: 86_400,
      statusPolicy: { statusListEnabled: true, suspensionAllowed: false },
      retentionPolicy: defaultRetentionPolicy(),
    },
    publish: true,
    at,
  });
  return { tenantId: asId<"TenantId">(tenant.id), policyId: policy.id };
}

describe("issuedCredentialId on an issued transaction", () => {
  it("is on the settling read and on every read after it, and the credential can then be revoked", async () => {
    const { tenantId, policyId } = await seedIssuer("Alpha");
    const created = await harness.deps.services.issuances.create({
      tenantId,
      policyId,
      subjectReference: "form-1",
      suppliedAttributes: { name: "Synthetic" },
    });
    harness.issuer?.settleLastIssued();
    const settling = await harness.deps.services.issuances.get(tenantId, created.issuanceId);
    expect(settling.status).toBe("ISSUED");
    expect(settling.issuedCredentialId).toBeDefined();

    const later = await harness.deps.services.issuances.get(tenantId, created.issuanceId);
    const again = await harness.deps.services.issuances.get(tenantId, created.issuanceId);
    expect(later.issuedCredentialId).toBe(settling.issuedCredentialId);
    expect(again.issuedCredentialId).toBe(settling.issuedCredentialId);

    const revoked = await harness.deps.services.issuances.changeCredentialStatus({
      tenantId,
      issuedCredentialId: later.issuedCredentialId as string,
      to: "REVOKED",
    });
    expect(revoked.status).toBe("REVOKED");
  });

  it("is absent before anything is issued", async () => {
    const { tenantId, policyId } = await seedIssuer("Beta");
    const created = await harness.deps.services.issuances.create({
      tenantId,
      policyId,
      subjectReference: "form-1",
      suppliedAttributes: { name: "Synthetic" },
    });
    const pending = await harness.deps.services.issuances.get(tenantId, created.issuanceId);
    expect(pending.status).toBe("AWAITING_WALLET");
    expect(pending.issuedCredentialId).toBeUndefined();
  });

  it("is never shown to another tenant, which gets not found", async () => {
    const alpha = await seedIssuer("Gamma");
    const beta = await seedIssuer("Delta");
    const created = await harness.deps.services.issuances.create({
      tenantId: alpha.tenantId,
      policyId: alpha.policyId,
      subjectReference: "form-1",
      suppliedAttributes: { name: "Synthetic" },
    });
    harness.issuer?.settleLastIssued();
    await harness.deps.services.issuances.get(alpha.tenantId, created.issuanceId);
    const error = await harness.deps.services.issuances
      .get(beta.tenantId, created.issuanceId)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).code).toBe("not_found");
  });
});
