import {
  type AccessCertificate,
  type CompilerInput,
  compilePresentationPolicy,
  defaultRetentionPolicy,
  defaultTrustPolicy,
  type IntendedUse,
  type PresentationPolicyVersion,
  type RegistrationCertificate,
  type RelyingParty,
  type RelyingPartyInstance,
  type RelyingPartyService,
} from "@edtp/domain";
import { asId, type PlatformError } from "@edtp/shared";
import { describe, expect, it } from "vitest";

/**
 * The presentation policy compiler.
 *
 * Produces the immutable `VerificationPlan` the adapter executes. Two things are asserted
 * throughout: the plan carries **no protocol structure** (no DCQL, no client-id scheme), and
 * it refuses to compile when the trust material does not actually belong to the Relying
 * Party Service it claims to serve.
 */
const tenantId = asId<"TenantId">("22222222-2222-2222-2222-222222222222");
const serviceId = asId<"RelyingPartyServiceId">("33333333-3333-3333-3333-333333333333");
const intendedUseId = asId<"IntendedUseId">("11111111-1111-1111-1111-111111111111");
const relyingPartyId = asId<"RelyingPartyId">("44444444-4444-4444-4444-444444444444");
const policyId = asId<"PresentationPolicyId">("55555555-5555-5555-5555-555555555555");
const at = new Date("2026-09-11T08:00:00Z");

const relyingParty: RelyingParty = {
  id: relyingPartyId,
  tenantId,
  organisationId: asId<"OrganisationId">("66666666-6666-6666-6666-666666666666"),
  registrarAssignedIdentifier: "NLNHR.12345678",
  registrar: "NL-Registrar",
  trustEnvironment: "TEST",
  createdAt: at,
};

const service: RelyingPartyService = {
  id: serviceId,
  tenantId,
  relyingPartyId,
  serviceIdentifier: "age-gate",
  serviceTradeName: "Example Age Gate",
  description: [{ lang: "en", value: "Age gate for account onboarding" }],
  callbackUrlAllowList: [],
  createdAt: at,
};

const instance: RelyingPartyInstance = {
  id: asId<"RelyingPartyInstanceId">("77777777-7777-7777-7777-777777777777"),
  tenantId,
  relyingPartyServiceId: serviceId,
  engineTenantRef: "engine-tenant-a",
  trustEnvironment: "TEST",
  createdAt: at,
};

const intendedUse: IntendedUse = {
  id: intendedUseId,
  tenantId,
  relyingPartyServiceId: serviceId,
  intendedUseIdentifier: "registrar-intended-use-1",
  purpose: [{ lang: "en", value: "Confirm the customer is an adult" }],
  privacyPolicyUris: [{ lang: "en", value: "https://verifier.example/privacy" }],
  registeredCredentials: [
    { format: "dc+sd-jwt", vctValues: ["urn:eudi:pid:1"], claims: [["birthdate"]] },
  ],
  validFrom: new Date("2026-01-01T00:00:00Z"),
  createdAt: at,
};

const accessCertificate: AccessCertificate = {
  id: asId<"AccessCertificateId">("88888888-8888-8888-8888-888888888888"),
  tenantId,
  relyingPartyId,
  relyingPartyServiceId: serviceId,
  keyBindingRef: "key-chain-1",
  trustEnvironment: "TEST",
  createdAt: at,
};

const policyVersion: PresentationPolicyVersion = {
  id: asId<"PresentationPolicyVersionId">("99999999-9999-9999-9999-999999999999"),
  tenantId,
  policyId,
  version: 3,
  purpose: [{ lang: "en", value: "Confirm the customer is an adult" }],
  credentialRequirements: [
    { credentialType: "urn:eudi:pid:1", acceptedFormats: ["dc+sd-jwt"] },
  ],
  requestedClaims: [{ path: ["birthdate"] }],
  trustPolicy: defaultTrustPolicy(),
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
  status: "PUBLISHED",
  createdAt: at,
  publishedAt: at,
};

const input = (overrides: Partial<CompilerInput> = {}): CompilerInput => ({
  policyVersion,
  relyingParty,
  relyingPartyService: service,
  relyingPartyInstance: instance,
  intendedUse,
  accessCertificate,
  at,
  ...overrides,
});

describe("compilePresentationPolicy", () => {
  it("produces a plan carrying the registered identifiers", () => {
    const plan = compilePresentationPolicy(input());

    expect(plan.policyId).toBe(policyId);
    expect(plan.policyVersion).toBe(3);
    // `Reg_32`, `Reg_33`, `Reg_34`: the identifiers and trade name the Wallet will match
    // against the access certificate.
    expect(plan.relyingPartyContext.relyingPartyIdentifier).toBe("NLNHR.12345678");
    expect(plan.relyingPartyContext.serviceIdentifier).toBe("age-gate");
    expect(plan.relyingPartyContext.serviceTradeName).toBe("Example Age Gate");
    expect(plan.relyingPartyContext.intendedUseIdentifier).toBe("registrar-intended-use-1");
    expect(plan.relyingPartyContext.accessKeyBindingRef).toBe("key-chain-1");
    expect(plan.relyingPartyContext.engineTenantRef).toBe("engine-tenant-a");
  });

  it("carries the vct values the adapter needs for a dc+sd-jwt requirement", () => {
    const plan = compilePresentationPolicy(input());
    expect(plan.credentialRequirement.vctValues).toEqual(["urn:eudi:pid:1"]);
    expect(plan.credentialRequirement.doctype).toBeUndefined();
  });

  it("contains no protocol structure", () => {
    const plan = compilePresentationPolicy(input());
    const serialised = JSON.stringify(plan);
    // DCQL, client-id schemes and response modes are the adapter's concern. If any of
    // these appeared here, the domain would have learned the protocol.
    expect(serialised).not.toContain("dcql");
    expect(serialised).not.toContain("client_id");
    expect(serialised).not.toContain("x509_hash");
    expect(serialised).not.toContain("direct_post");
    expect(serialised).not.toContain("vct_values");
  });

  it("is deeply frozen so no caller can mutate a compiled plan", () => {
    const plan = compilePresentationPolicy(input());
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.relyingPartyContext)).toBe(true);
    expect(Object.isFrozen(plan.credentialRequirement)).toBe(true);
  });

  it("reports the absence of a registration certificate rather than inventing one", () => {
    // `EW-DM-44-023` (`RPRC_19`) requires one by value. V0 has no reachable provider, so
    // the field is simply absent and the omission travels upward.
    const plan = compilePresentationPolicy(input());
    expect(plan.relyingPartyContext.registrationCertificateJwt).toBeUndefined();
  });

  it("attaches the registration certificate when one exists", () => {
    const registrationCertificate: RegistrationCertificate = {
      id: asId<"RegistrationCertificateId">("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
      tenantId,
      relyingPartyServiceId: serviceId,
      intendedUseId,
      jwt: "eyJhbGciOiJFUzI1NiJ9.e30.sig",
      trustEnvironment: "TEST",
      createdAt: at,
    };
    const plan = compilePresentationPolicy(input({ registrationCertificate }));
    expect(plan.relyingPartyContext.registrationCertificateJwt).toBe(
      "eyJhbGciOiJFUzI1NiJ9.e30.sig",
    );
  });

  it("refuses a draft policy version", () => {
    expect(() =>
      compilePresentationPolicy(
        input({ policyVersion: { ...policyVersion, status: "DRAFT" } }),
      ),
    ).toThrowError(/only a published policy version/i);
  });

  it("refuses an access certificate bound to a different Service", () => {
    const foreign: AccessCertificate = {
      ...accessCertificate,
      relyingPartyServiceId: asId<"RelyingPartyServiceId">(
        "dddddddd-dddd-dddd-dddd-dddddddddddd",
      ),
    };
    expect(() => compilePresentationPolicy(input({ accessCertificate: foreign }))).toThrowError(
      /not bound to the Relying Party Service/i,
    );
  });

  it("refuses an expired access certificate", () => {
    // `AS-WP-06-004` (`RPA_03`) requires Relying Party authentication in every presentation
    // transaction; an expired certificate cannot provide it.
    const expired: AccessCertificate = {
      ...accessCertificate,
      notAfter: new Date("2026-01-01T00:00:00Z"),
    };
    expect(() => compilePresentationPolicy(input({ accessCertificate: expired }))).toThrowError(
      /access certificate .* has expired/i,
    );
  });

  it("refuses a registration certificate issued for a different intended use", () => {
    // `EW-DM-44-014` (`RPRC_09`) pairs a certificate with exactly one intended use.
    const mismatched: RegistrationCertificate = {
      id: asId<"RegistrationCertificateId">("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
      tenantId,
      relyingPartyServiceId: serviceId,
      intendedUseId: asId<"IntendedUseId">("cccccccc-cccc-cccc-cccc-cccccccccccc"),
      jwt: "x.y.z",
      trustEnvironment: "TEST",
      createdAt: at,
    };
    expect(() =>
      compilePresentationPolicy(input({ registrationCertificate: mismatched })),
    ).toThrowError(/not the one issued for this intended use/i);
  });

  it("refuses mixed trust environments", () => {
    // Mixing TEST material into a PRODUCTION registration would misrepresent the requester.
    expect(() =>
      compilePresentationPolicy(
        input({ relyingParty: { ...relyingParty, trustEnvironment: "PRODUCTION" } }),
      ),
    ).toThrowError(/one trust environment/i);
  });

  it("re-validates against the intended use, so a later registration change cannot widen a request", () => {
    // The version was valid when published. The registration has since narrowed, and the
    // compiler must refuse rather than send a request the Wallet would warn about.
    const narrowed: IntendedUse = {
      ...intendedUse,
      registeredCredentials: [
        { format: "dc+sd-jwt", vctValues: ["urn:eudi:pid:1"], claims: [["given_name"]] },
      ],
    };
    try {
      compilePresentationPolicy(input({ intendedUse: narrowed }));
      throw new Error("expected the compiler to refuse");
    } catch (error) {
      const platformError = error as PlatformError;
      expect(platformError.code).toBe("policy_no_longer_valid");
      expect(platformError.kind).toBe("UNPROCESSABLE");
    }
  });

  it("refuses an intended use registered for another Service", () => {
    // `AS-MS-27-016` (`Reg_10d`) registers intended uses per Service. Borrowing another
    // Service's intended use would produce a request whose registration certificate carried
    // the wrong Service identifier — which `EW-DM-44-020` (`RPRC_17a`) makes the Wallet warn
    // about. Caught here as defence in depth, independently of the repository loader.
    const foreignUse: IntendedUse = {
      ...intendedUse,
      relyingPartyServiceId: asId<"RelyingPartyServiceId">(
        "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      ),
    };
    expect(() => compilePresentationPolicy(input({ intendedUse: foreignUse }))).toThrowError(
      /not registered for the Relying Party Service/i,
    );
  });

  it("refuses an instance that serves another Service", () => {
    const foreignInstance: RelyingPartyInstance = {
      ...instance,
      relyingPartyServiceId: asId<"RelyingPartyServiceId">(
        "ffffffff-ffff-ffff-ffff-ffffffffffff",
      ),
    };
    expect(() =>
      compilePresentationPolicy(input({ relyingPartyInstance: foreignInstance })),
    ).toThrowError(/does not serve the Relying Party Service/i);
  });

  it("refuses a Service that belongs to another Relying Party", () => {
    const foreignService: RelyingPartyService = {
      ...service,
      relyingPartyId: asId<"RelyingPartyId">("00000000-0000-0000-0000-000000000001"),
    };
    expect(() =>
      compilePresentationPolicy(input({ relyingPartyService: foreignService })),
    ).toThrowError(/does not belong to that Relying Party/i);
  });
});
