import { randomUUID } from "node:crypto";
import { defaultRetentionPolicy } from "@edtp/domain";
import { tables } from "@edtp/persistence";
import { asId } from "@edtp/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../support/harness.js";

/**
 * The engine's issuer configuration is **tenant-scoped**, and the platform composes it per provider.
 *
 * `POST /issuer/config` carries `authorizationServers`, the Credential Issuer's `display`, and the
 * registration certificate published as `issuer_info` — trust gate (a), ARF §6.6.2.2. None of them
 * belongs to a credential configuration. The platform wrote all three from whichever credential type
 * happened to be provisioning, so every issuance silently overwrote the previous one's:
 * `docs/interop-findings.md` A20, observed on 13 September 2026 while exercising §7.3 for the first
 * time.
 *
 * Two things follow, and both are tested here rather than in the adapter, because both are decisions
 * the **platform** makes about its own model:
 *
 * 1. The composition is read from the provider — every published policy on it — not from one policy.
 * 2. An engine tenant serves exactly one Attestation Provider, or (1) is not the whole truth about
 *    that tenant, and one provider's registration certificate would be published for another's
 *    credentials.
 */
let harness: Harness;

beforeEach(async () => {
  harness ??= await createHarness();
  await harness.reset();
});

afterAll(async () => {
  await harness?.close();
});

const issuance = () => harness.deps.repositories.issuance;

/** A tenant, an organisation and an Attestation Provider, using the real writes. */
const seedProvider = async (legalName: string) => {
  const tenantId = asId<"TenantId">(randomUUID());
  const at = harness.clock.now();
  await harness.deps.db
    .insert(tables.tenants)
    .values({ id: tenantId, name: legalName, createdAt: at });

  const organisationId = randomUUID();
  await harness.deps.db.insert(tables.organisations).values({
    id: organisationId,
    tenantId,
    legalName,
    officialIdentifiers: [
      { scheme: "http://data.europa.eu/eudi/id/EUID", value: "NL.KVK.0001" },
    ],
    memberState: "NL",
    isPublicSectorBody: false,
    createdAt: at,
  });

  const provider = await issuance().createAttestationProvider({
    tenantId,
    organisationId,
    registrarAssignedIdentifier: `NLAP.${randomUUID().slice(0, 8)}`,
    trustEnvironment: "TEST",
    at,
  });

  const type = await issuance().createCredentialType({
    tenantId,
    type: {
      attestationProviderId: provider.id,
      name: "Employee badge",
      format: "dc+sd-jwt",
      vct: "urn:edtp:employee-badge:1",
      rulebook: {
        identifier: "urn:edtp:rulebook:employee-badge",
        version: "1.0",
        anchorSource: "RULEBOOK_ONLY",
      },
      claims: [
        {
          path: ["employee_id"],
          display: [{ lang: "en", value: "Employee number" }],
          mandatory: true,
          valueType: "string",
        },
      ],
      display: [{ lang: "en", value: "Employee badge" }],
      validitySeconds: 86_400,
      statusMechanism: "NONE",
      requiresKeyBinding: true,
    },
    at,
  });

  return { tenantId, organisationId, providerId: provider.id, credentialTypeId: type.id, at };
};

/** A published issuance policy, optionally gated on a presentation policy. */
const seedPolicy = async (
  seed: Awaited<ReturnType<typeof seedProvider>>,
  options: { readonly name: string; readonly gatedOn?: string; readonly publish?: boolean },
) => {
  const policy = await issuance().createPolicy({
    tenantId: seed.tenantId,
    credentialTypeId: seed.credentialTypeId,
    name: options.name,
    at: seed.at,
  });
  await issuance().createVersion({
    tenantId: seed.tenantId,
    policyId: policy.id,
    body: {
      credentialTypeId: seed.credentialTypeId,
      purpose: [{ lang: "en", value: options.name }],
      eligibilityRule: { evaluator: "AlwaysEligible", parameters: {} },
      authenticSource: { connector: "fixture", parameters: {} },
      holderBinding: "KEY_BOUND",
      flow: "PRE_AUTHORIZED_CODE",
      credentialValiditySeconds: 3_600,
      statusPolicy: { statusListEnabled: false, suspensionAllowed: false },
      retentionPolicy: defaultRetentionPolicy(),
      ...(options.gatedOn ? { eligibilityPresentationPolicyId: options.gatedOn } : {}),
    },
    publish: options.publish ?? true,
    at: seed.at,
  });
  return policy;
};

/** A published presentation policy to gate on, created with the verification-side writes. */
const seedPresentationPolicy = async (
  seed: Awaited<ReturnType<typeof seedProvider>>,
  name: string,
): Promise<string> => {
  // Inserted directly: this test is about the issuer-side read, and building the full
  // Relying Party chain to reach a presentation policy would obscure what is being asserted.
  const serviceId = randomUUID();
  const relyingPartyId = randomUUID();
  const intendedUseId = randomUUID();
  const policyId = randomUUID();
  await harness.deps.db.insert(tables.relyingParties).values({
    id: relyingPartyId,
    tenantId: seed.tenantId,
    organisationId: seed.organisationId,
    registrarAssignedIdentifier: `NLRP.${randomUUID().slice(0, 8)}`,
    registrar: "NL-Registrar-Sandbox",
    trustEnvironment: "TEST",
    createdAt: seed.at,
  });
  await harness.deps.db.insert(tables.relyingPartyServices).values({
    id: serviceId,
    tenantId: seed.tenantId,
    relyingPartyId,
    serviceIdentifier: `svc-${randomUUID().slice(0, 8)}`,
    serviceTradeName: name,
    description: [{ lang: "en", value: name }],
    callbackUrlAllowList: [],
    createdAt: seed.at,
  });
  await harness.deps.db.insert(tables.intendedUses).values({
    id: intendedUseId,
    tenantId: seed.tenantId,
    relyingPartyServiceId: serviceId,
    intendedUseIdentifier: `iu-${randomUUID().slice(0, 8)}`,
    purpose: [{ lang: "en", value: name }],
    privacyPolicyUris: [{ lang: "en", value: "https://example.test/privacy" }],
    registeredCredentials: [],
    validFrom: seed.at,
    createdAt: seed.at,
  });
  await harness.deps.db.insert(tables.presentationPolicies).values({
    id: policyId,
    tenantId: seed.tenantId,
    relyingPartyServiceId: serviceId,
    intendedUseId,
    name,
    description: name,
    status: "ACTIVE",
    createdAt: seed.at,
  });
  return policyId;
};

describe("the issuer configuration is composed from the provider, not from one policy", () => {
  it("names the Credential Issuer after the organisation", async () => {
    // Not after the credential type. The credential type here is called "Employee badge", which is
    // exactly the name that ended up announced as the issuer's.
    const seed = await seedProvider("Example Organisation BV");
    await seedPolicy(seed, { name: "Badge issuance" });

    const config = await issuance().issuerConfigurationInputs(seed.tenantId, seed.providerId);
    expect(config.issuerDisplayName).toBe("Example Organisation BV");
  });

  it("carries every gating policy on the provider, and the built-in server alongside", async () => {
    // The A20 case exactly: one PID-gated credential type and one ordinary one on the same engine
    // tenant. Before the fix, whichever provisioned last was the only one advertised.
    const seed = await seedProvider("Example Organisation BV");
    const gate = await seedPresentationPolicy(seed, "Adult verification");
    await seedPolicy(seed, { name: "Gated issuance", gatedOn: gate });
    await seedPolicy(seed, { name: "Ordinary issuance" });

    const config = await issuance().issuerConfigurationInputs(seed.tenantId, seed.providerId);
    expect(config.eligibilityPresentationPolicyIds).toEqual([gate]);
    expect(config.requiresBuiltInAuthorizationServer).toBe(true);
  });

  it("omits the built-in server when every published policy is gated", async () => {
    const seed = await seedProvider("Example Organisation BV");
    const gate = await seedPresentationPolicy(seed, "Adult verification");
    await seedPolicy(seed, { name: "Gated issuance", gatedOn: gate });

    const config = await issuance().issuerConfigurationInputs(seed.tenantId, seed.providerId);
    expect(config.eligibilityPresentationPolicyIds).toEqual([gate]);
    expect(config.requiresBuiltInAuthorizationServer).toBe(false);
  });

  it("ignores a draft version, because it has not been validated for use", async () => {
    // A draft must not change what the Credential Issuer metadata advertises to every Wallet.
    const seed = await seedProvider("Example Organisation BV");
    const gate = await seedPresentationPolicy(seed, "Adult verification");
    await seedPolicy(seed, { name: "Draft gated issuance", gatedOn: gate, publish: false });
    await seedPolicy(seed, { name: "Ordinary issuance" });

    const config = await issuance().issuerConfigurationInputs(seed.tenantId, seed.providerId);
    expect(config.eligibilityPresentationPolicyIds).toEqual([]);
  });

  it("does not see another provider's policies", async () => {
    const mine = await seedProvider("Mine BV");
    const theirs = await seedProvider("Theirs BV");
    const gate = await seedPresentationPolicy(theirs, "Their gate");
    await seedPolicy(theirs, { name: "Their gated issuance", gatedOn: gate });
    await seedPolicy(mine, { name: "My issuance" });

    const config = await issuance().issuerConfigurationInputs(mine.tenantId, mine.providerId);
    expect(config.eligibilityPresentationPolicyIds).toEqual([]);
    expect(config.issuerDisplayName).toBe("Mine BV");
  });
});

describe("one engine tenant per Attestation Provider", () => {
  const provision = async (
    seed: Awaited<ReturnType<typeof seedProvider>>,
    engineTenantRef: string,
  ) =>
    issuance().provisionAttestationProvider({
      tenantId: seed.tenantId,
      attestationProviderId: seed.providerId,
      engineTenantRef,
      signingKeyBindingRef: "key-1",
    });

  it("refuses a reference another provider already holds", async () => {
    // Sharing would make each provider overwrite the other's authorization servers, display name
    // and — the one that matters — registration certificate, which is trust gate (a).
    const first = await seedProvider("First BV");
    const second = await seedProvider("Second BV");
    await provision(first, "engine-tenant-shared");

    await expect(provision(second, "engine-tenant-shared")).rejects.toMatchObject({
      code: "engine_tenant_already_assigned",
    });
  });

  it("refuses across platform tenants too, because the engine has one namespace", async () => {
    // The reference names an engine-side object. Two platform tenants are no protection at all.
    const first = await seedProvider("First BV");
    const second = await seedProvider("Second BV");
    expect(first.tenantId).not.toBe(second.tenantId);
    await provision(first, "engine-tenant-cross");

    await expect(provision(second, "engine-tenant-cross")).rejects.toMatchObject({
      code: "engine_tenant_already_assigned",
    });
  });

  it("lets a released reference be given to another provider", async () => {
    // The way back. Without it the rule is a one-way door: the first provider to claim an engine
    // tenant holds it for the life of the database, and one registered by mistake makes that engine
    // tenant permanently unusable. A constraint with no way back is a defect, not a safeguard.
    const first = await seedProvider("First BV");
    const second = await seedProvider("Second BV");
    await provision(first, "engine-tenant-released");

    const released = await issuance().releaseEngineTenant({
      tenantId: first.tenantId,
      attestationProviderId: first.providerId,
    });
    expect(released.released).toBe("engine-tenant-released");

    await expect(provision(second, "engine-tenant-released")).resolves.toBeUndefined();
  });

  it("reports honestly when the provider held nothing", async () => {
    // Not an error — releasing an unprovisioned provider is a no-op — but not the same event either.
    const provider = await seedProvider("First BV");
    const released = await issuance().releaseEngineTenant({
      tenantId: provider.tenantId,
      attestationProviderId: provider.providerId,
    });
    expect(released.released).toBeUndefined();
  });

  it("clears the signing key with the reference, so nothing reads as still provisioned", async () => {
    // Both describe the same engine tenant. A key reference left behind would let a later read
    // believe the provider is usable, and issuance would fail somewhere less informative.
    const provider = await seedProvider("First BV");
    await provision(provider, "engine-tenant-keys");
    await issuance().releaseEngineTenant({
      tenantId: provider.tenantId,
      attestationProviderId: provider.providerId,
    });

    const context = await issuance().loadIssuanceContext(
      provider.tenantId,
      provider.credentialTypeId,
    );
    expect(context.attestationProvider.engineTenantRef).toBeUndefined();
    expect(context.attestationProvider.signingKeyBindingRef).toBeUndefined();
  });

  it("lets a provider be re-provisioned with the reference it already holds", async () => {
    // Re-provisioning is how a signing key or registration certificate is replaced, and it must not
    // trip over the provider's own reference.
    const provider = await seedProvider("First BV");
    await provision(provider, "engine-tenant-reprovision");
    await expect(provision(provider, "engine-tenant-reprovision")).resolves.toBeUndefined();
  });
});
