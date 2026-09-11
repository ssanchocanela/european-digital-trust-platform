import type { PresentationPolicyId, RelyingPartyServiceId, TenantId } from "@edtp/shared";
import { asId } from "@edtp/shared";
import type { Harness } from "./harness.js";
import { TEST_CERTIFICATE_PEM, TEST_PRIVATE_JWK } from "./harness.js";

/**
 * Seeds a complete, usable tenant: the configuration chain the V0 end-to-end target
 * describes — Tenant, Organisation, Relying Party (TEST), Service, Intended Use,
 * Relying Party Instance with an imported access certificate, and a published Presentation
 * Policy.
 *
 * Uses the real services rather than inserting rows directly, so the seed itself exercises
 * the registration path and a test cannot pass against data the API could not have created.
 */
export interface SeededTenant {
  readonly tenantId: TenantId;
  readonly apiKey: string;
  readonly serviceId: RelyingPartyServiceId;
  readonly intendedUseId: string;
  readonly policyId: PresentationPolicyId;
  readonly webhookSecret: string;
  readonly engineTenantRef: string;
}

export interface SeedOptions {
  readonly name?: string;
  readonly engineTenantRef?: string;
  readonly callbackUrlAllowList?: readonly string[];
  /** Registered claims for the intended use. Defaults to the PID date of birth. */
  readonly registeredClaims?: readonly (string | number | null)[][];
  /** Whether to publish a policy version. */
  readonly publishPolicy?: boolean;
  /** Supply a registration certificate JWT, which V0 normally cannot obtain. */
  readonly registrationCertificateJwt?: string;
}

export const seedTenant = async (
  harness: Harness,
  options: SeedOptions = {},
): Promise<SeededTenant> => {
  const { registration, policies } = harness.deps.services;
  const engineTenantRef = options.engineTenantRef ?? "engine-tenant-a";

  const { tenant, apiKey } = await registration.createTenant(
    options.name ?? "Example Retailer",
  );

  const organisation = await registration.createOrganisation({
    tenantId: tenant.id,
    legalName: "Example Retailer B.V.",
    memberState: "NL",
    isPublicSectorBody: false,
    // TS5 §2.4.3.1 makes the European unique identifier the default scheme.
    officialIdentifiers: [
      { scheme: "http://data.europa.eu/eudi/id/EUID", value: "NLNHR.12345678" },
    ],
  });

  const relyingParty = await registration.createRelyingParty({
    tenantId: tenant.id,
    organisationId: organisation.id,
    registrarAssignedIdentifier: `NLNHR.${Math.floor(Math.random() * 1e8)}`,
    registrar: "NL-Registrar-Sandbox",
    trustEnvironment: "TEST",
  });

  const { service, webhookSecret } = await registration.createRelyingPartyService({
    tenantId: tenant.id,
    relyingPartyId: relyingParty.id,
    serviceIdentifier: "age-gate",
    serviceTradeName: "Example Age Gate",
    description: [{ lang: "en", value: "Age gate for account onboarding" }],
    callbackUrlAllowList: options.callbackUrlAllowList ?? [],
  });

  const intendedUse = await registration.createIntendedUse({
    tenantId: tenant.id,
    relyingPartyServiceId: service.id,
    intendedUseIdentifier: "registrar-intended-use-1",
    purpose: [{ lang: "en", value: "Confirm the customer is an adult" }],
    privacyPolicyUris: [{ lang: "en", value: "https://verifier.example/privacy" }],
    registeredCredentials: [
      {
        format: "dc+sd-jwt",
        vctValues: ["urn:eudi:pid:1"],
        claims: (options.registeredClaims ?? [["birthdate"]]) as never,
      },
    ],
  });

  await registration.recordRegistrationCertificate({
    tenantId: tenant.id,
    relyingPartyServiceId: service.id,
    intendedUseId: intendedUse.id,
    ...(options.registrationCertificateJwt ? { jwt: options.registrationCertificateJwt } : {}),
    trustEnvironment: "TEST",
  });

  await registration.provisionInstance({
    tenantId: tenant.id,
    relyingPartyServiceId: service.id,
    engineTenantRef,
    trustEnvironment: "TEST",
    accessCertificate: {
      privateKeyJwk: TEST_PRIVATE_JWK,
      certificateChain: [TEST_CERTIFICATE_PEM],
      subject: "CN=Example Age Gate",
      issuer: "CN=Development Access CA",
    },
  });

  const policy = await policies.createPolicy({
    tenantId: tenant.id,
    relyingPartyServiceId: service.id,
    intendedUseId: intendedUse.id,
    name: "Adult verification",
    description: "Confirms the customer is at least 18 years old.",
  });

  if (options.publishPolicy !== false) {
    await policies.createVersion({
      tenantId: tenant.id,
      policyId: policy.id,
      purpose: [{ lang: "en", value: "Confirm the customer is an adult" }],
      credentialRequirements: [
        { credentialType: "urn:eudi:pid:1", acceptedFormats: ["dc+sd-jwt"] },
      ],
      requestedClaims: [{ path: ["birthdate"] }],
      // ADR 0005 Decision 5: derivation is the primary route for an age check, because
      // `age_over_18` is no longer a PID attribute.
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
      publish: true,
    });
  }

  return {
    tenantId: tenant.id,
    apiKey,
    serviceId: service.id,
    intendedUseId: intendedUse.id,
    policyId: policy.id,
    webhookSecret,
    engineTenantRef,
  };
};

export const asPolicyId = (value: string): PresentationPolicyId =>
  asId<"PresentationPolicyId">(value);
