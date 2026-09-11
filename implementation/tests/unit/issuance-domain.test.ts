import {
  ALL_ISSUANCE_STATES,
  allowedIssuanceTransitionsFrom,
  assertIssuanceTransition,
  assertPublishable,
  assertStatusTransition,
  assertTrustListSigningKey,
  buildTrustAnchorListBody,
  type CredentialType,
  canTransitionIssuance,
  canTransitionStatus,
  compileIssuancePolicy,
  defaultRetentionPolicy,
  type IssuancePolicyVersion,
  isIssuanceTerminal,
  isPublicationStale,
  narrowToDeclaredClaims,
  TEST_SCHEME_NAME_PREFIX,
  type TrustAnchorPublication,
  validateCredentialType,
  validateIssuancePolicyVersion,
} from "@edtp/domain";
import { asId } from "@edtp/shared";
import { describe, expect, it } from "vitest";

/**
 * Asserts a refusal, matching against the whole error — code, message **and** details.
 *
 * `PlatformError.unprocessable` keeps the specifics in `details` and leaves the message generic, so
 * matching only on `message` would pass for any validation failure rather than the intended one.
 * This checks the serialised error, which is what a caller actually receives.
 */
const expectRefusal = (fn: () => unknown, pattern: RegExp): void => {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, "expected a refusal but none was thrown").toBeDefined();
  const serialised = JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object));
  expect(serialised).toMatch(pattern);
};

/** Just enough of the ETSI TS 119 602 list shape for the assertions below to be typed. */
interface TrustListBody {
  readonly ListAndSchemeInformation: {
    readonly SchemeName: readonly { readonly value: string }[];
    readonly SchemeTypeCommunityRules: readonly { readonly value: string }[];
  };
  readonly TrustedEntitiesList: readonly {
    readonly TrustedEntityServices: readonly {
      readonly ServiceInformation: {
        readonly ServiceTypeIdentifier: string;
        readonly ServiceStatus: string;
        readonly ServiceDigitalIdentity: {
          readonly X509Certificates: readonly { readonly val: string }[];
        };
      };
    }[];
  }[];
}

const at = new Date("2026-09-11T12:00:00Z");

const rulebook = {
  identifier: "urn:edtp:rulebook:employee-badge",
  version: "1.0",
  anchorSource: "RULEBOOK_ONLY" as const,
};

/** The tenant both the credential type and the Attestation Provider must belong to. */
const TENANT = "11111111-1111-1111-1111-111111111111";

const credentialType = (overrides: Partial<CredentialType> = {}): CredentialType => ({
  id: "type-1",
  tenantId: TENANT,
  attestationProviderId: "provider-1",
  name: "Employee badge",
  format: "dc+sd-jwt",
  vct: "urn:edtp:employee-badge:1",
  rulebook,
  claims: [
    {
      path: ["employee_id"],
      display: [{ lang: "en", value: "Employee number" }],
      mandatory: true,
      valueType: "string",
    },
    {
      path: ["birthdate"],
      display: [{ lang: "en", value: "Date of birth" }],
      mandatory: true,
      valueType: "date",
    },
  ],
  display: [{ lang: "en", value: "Employee badge" }],
  validitySeconds: 86_400,
  statusMechanism: "TOKEN_STATUS_LIST",
  requiresKeyBinding: true,
  createdAt: at,
  ...overrides,
});

// ---------------------------------------------------------------------------------------
describe("credential type validation", () => {
  it("requires a Rulebook, because the Rulebook is where trust anchors come from", () => {
    // ARF §6.3.2.4: for a non-qualified EAA the verifier gets the provider's trust anchors from
    // the applicable Rulebook. A type without one cannot be verified, so it must not exist.
    expectRefusal(
      () =>
        validateCredentialType({
          format: "dc+sd-jwt",
          vct: "urn:x:1",
          rulebook: { identifier: "   ", version: "1.0", anchorSource: "RULEBOOK_ONLY" },
          claims: credentialType().claims,
          display: credentialType().display,
          validitySeconds: 60,
          statusMechanism: "NONE",
        }),
      /rulebook/i,
    );
  });

  it("requires a Rulebook version, because anchors change between versions", () => {
    expectRefusal(
      () =>
        validateCredentialType({
          format: "dc+sd-jwt",
          vct: "urn:x:1",
          rulebook: { identifier: "urn:x", version: "", anchorSource: "RULEBOOK_ONLY" },
          claims: credentialType().claims,
          display: credentialType().display,
          validitySeconds: 60,
          statusMechanism: "NONE",
        }),
      /version/i,
    );
  });

  it("refuses an SD-JWT VC type with no vct, and one that also declares a doctype", () => {
    const base = {
      rulebook,
      claims: credentialType().claims,
      display: credentialType().display,
      validitySeconds: 60,
      statusMechanism: "NONE" as const,
    };
    expectRefusal(() => validateCredentialType({ ...base, format: "dc+sd-jwt" }), /vct/i);
    expectRefusal(
      () =>
        validateCredentialType({
          ...base,
          format: "dc+sd-jwt",
          vct: "urn:x:1",
          doctype: "a.b.c",
        }),
      /doctype/i,
    );
  });

  it("requires display text on every claim, because the User must be able to consent to it", () => {
    expectRefusal(
      () =>
        validateCredentialType({
          format: "dc+sd-jwt",
          vct: "urn:x:1",
          rulebook,
          claims: [{ path: ["x"], display: [], mandatory: true, valueType: "string" }],
          display: credentialType().display,
          validitySeconds: 60,
          statusMechanism: "NONE",
        }),
      /display/i,
    );
  });

  it("refuses a duplicated claim path", () => {
    const claim = {
      path: ["employee_id"],
      display: [{ lang: "en", value: "x" }],
      mandatory: true,
      valueType: "string" as const,
    };
    expectRefusal(
      () =>
        validateCredentialType({
          format: "dc+sd-jwt",
          vct: "urn:x:1",
          rulebook,
          claims: [claim, claim],
          display: credentialType().display,
          validitySeconds: 60,
          statusMechanism: "NONE",
        }),
      /more than once/i,
    );
  });
});

// ---------------------------------------------------------------------------------------
describe("issuance policy validation against its credential type", () => {
  const base = {
    credentialTypeId: "type-1",
    purpose: [{ lang: "en", value: "Issue an employee badge" }],
    eligibilityRule: { evaluator: "AlwaysEligible", parameters: {} },
    authenticSource: { connector: "fixture", parameters: {} },
    holderBinding: "KEY_BOUND" as const,
    flow: "PRE_AUTHORIZED_CODE" as const,
    credentialValiditySeconds: 3_600,
    statusPolicy: { statusListEnabled: true, suspensionAllowed: false },
    retentionPolicy: defaultRetentionPolicy(),
  };
  const context = {
    credentialType: credentialType(),
    registeredEvaluators: ["AlwaysEligible", "MinimumAge"],
    registeredConnectors: ["fixture"],
    at,
  };

  it("accepts a consistent policy", () => {
    expect(() => validateIssuancePolicyVersion(base, context)).not.toThrow();
  });

  it("refuses an unregistered evaluator at publication, not at issuance", () => {
    // A typo must fail while a reviewer is present, not while a User waits.
    expectRefusal(
      () =>
        validateIssuancePolicyVersion(
          { ...base, eligibilityRule: { evaluator: "Typo", parameters: {} } },
          context,
        ),
      /evaluator_not_registered/,
    );
  });

  it("refuses an unregistered connector", () => {
    expectRefusal(
      () =>
        validateIssuancePolicyVersion(
          { ...base, authenticSource: { connector: "nope", parameters: {} } },
          context,
        ),
      /connector_not_registered/,
    );
  });

  it("refuses BEARER over a type that requires key binding, and the reverse", () => {
    expectRefusal(
      () => validateIssuancePolicyVersion({ ...base, holderBinding: "BEARER" }, context),
      /key binding/i,
    );

    expect(() =>
      validateIssuancePolicyVersion(
        { ...base, holderBinding: "BEARER" },
        { ...context, credentialType: credentialType({ requiresKeyBinding: false }) },
      ),
    ).not.toThrow();
  });

  it("refuses a status list the type cannot support, because revocation would silently do nothing", () => {
    expectRefusal(
      () =>
        validateIssuancePolicyVersion(base, {
          ...context,
          credentialType: credentialType({ statusMechanism: "NONE" }),
        }),
      /status mechanism/i,
    );
  });

  it("refuses validity longer than the type allows, but permits shortening it", () => {
    expectRefusal(
      () =>
        validateIssuancePolicyVersion({ ...base, credentialValiditySeconds: 999_999 }, context),
      /caps validity/i,
    );
    expect(() =>
      validateIssuancePolicyVersion({ ...base, credentialValiditySeconds: 60 }, context),
    ).not.toThrow();
  });

  it("refuses suspension without a status list", () => {
    expectRefusal(
      () =>
        validateIssuancePolicyVersion(
          {
            ...base,
            statusPolicy: { statusListEnabled: false, suspensionAllowed: true },
          },
          { ...context, credentialType: credentialType({ statusMechanism: "NONE" }) },
        ),
      /status list/i,
    );
  });

  it("refuses a type whose Rulebook expects a published list that does not exist", () => {
    // ARF §6.3.2.4: if the anchors are supposed to come from a published list, a verifier must be
    // able to resolve it. Issuing something unverifiable is worse than refusing.
    expectRefusal(
      () =>
        validateIssuancePolicyVersion(base, {
          ...context,
          credentialType: credentialType({
            rulebook: {
              identifier: "urn:x",
              version: "1.0",
              anchorSource: "RULEBOOK_AND_PUBLISHED_LIST",
            },
          }),
        }),
      /published list/i,
    );
  });
});

// ---------------------------------------------------------------------------------------
describe("issuance transaction state machine", () => {
  it("walks the happy path", () => {
    expect(canTransitionIssuance("CREATED", "OFFER_READY")).toBe(true);
    expect(canTransitionIssuance("OFFER_READY", "AWAITING_WALLET")).toBe(true);
    expect(canTransitionIssuance("AWAITING_WALLET", "ELIGIBILITY_CHECK")).toBe(true);
    expect(canTransitionIssuance("ELIGIBILITY_CHECK", "ISSUING")).toBe(true);
    expect(canTransitionIssuance("ISSUING", "ISSUED")).toBe(true);
  });

  it("allows NOT_ELIGIBLE only from ELIGIBILITY_CHECK", () => {
    // It is an answer to a question that must actually have been asked.
    expect(canTransitionIssuance("ELIGIBILITY_CHECK", "NOT_ELIGIBLE")).toBe(true);
    for (const from of ALL_ISSUANCE_STATES) {
      if (from === "ELIGIBILITY_CHECK") continue;
      expect(canTransitionIssuance(from, "NOT_ELIGIBLE")).toBe(false);
    }
  });

  it("stops cancellation once eligibility has been checked", () => {
    // By then the platform has consulted an authentic source about a person; by ISSUING an
    // attestation may exist in a Wallet. Either way there is something to record an outcome for.
    expect(canTransitionIssuance("AWAITING_WALLET", "CANCELLED")).toBe(true);
    expect(canTransitionIssuance("ELIGIBILITY_CHECK", "CANCELLED")).toBe(false);
    expect(canTransitionIssuance("ISSUING", "CANCELLED")).toBe(false);
  });

  it("allows EXPIRED from every non-terminal state", () => {
    for (const from of ALL_ISSUANCE_STATES) {
      if (isIssuanceTerminal(from)) continue;
      expect(canTransitionIssuance(from, "EXPIRED"), `${from} -> EXPIRED`).toBe(true);
    }
  });

  it("lets nothing leave a terminal state", () => {
    for (const from of ALL_ISSUANCE_STATES) {
      if (!isIssuanceTerminal(from)) continue;
      expect(allowedIssuanceTransitionsFrom(from)).toHaveLength(0);
    }
  });

  it("rejects an illegal transition with a named error", () => {
    expectRefusal(() => assertIssuanceTransition("CREATED", "ISSUED"), /cannot move/i);
  });
});

// ---------------------------------------------------------------------------------------
describe("credential status — VCR_04", () => {
  it("refuses un-revocation, and says why", () => {
    // `AS-AP-07-007`: a provider that revoked an attestation SHALL NOT reverse the revocation.
    // The engine would accept this call, so the platform is the only thing stopping it.
    expectRefusal(() => assertStatusTransition("REVOKED", "VALID"), /irreversible/i);
    expectRefusal(() => assertStatusTransition("REVOKED", "SUSPENDED"), /irreversible/i);
    expect(canTransitionStatus("REVOKED", "VALID")).toBe(false);
  });

  it("permits reinstatement from suspended, which is the point of having suspension", () => {
    expect(() => assertStatusTransition("SUSPENDED", "VALID")).not.toThrow();
    expect(() => assertStatusTransition("SUSPENDED", "REVOKED")).not.toThrow();
  });

  it("honours a policy that does not permit suspension", () => {
    expectRefusal(
      () => assertStatusTransition("VALID", "SUSPENDED", { suspensionAllowed: false }),
      /not permit suspension/i,
    );
    expect(() =>
      assertStatusTransition("VALID", "SUSPENDED", { suspensionAllowed: true }),
    ).not.toThrow();
  });

  it("refuses a no-op rather than reporting a change that did not happen", () => {
    expectRefusal(() => assertStatusTransition("VALID", "VALID"), /already/i);
  });
});

// ---------------------------------------------------------------------------------------
describe("narrowing an authentic source response", () => {
  it("drops attributes the type does not declare", () => {
    // Minimisation at the source. A real source returning surplus attributes is the common case,
    // and passing them on would put them in the attestation.
    const narrowed = narrowToDeclaredClaims(
      {
        employee_id: "E-1",
        birthdate: "1990-01-01",
        internal_hr_notes: "MUST NOT APPEAR",
        salary: 12345,
      },
      credentialType(),
    );
    expect(narrowed).toEqual({ employee_id: "E-1", birthdate: "1990-01-01" });
    expect(JSON.stringify(narrowed)).not.toContain("MUST NOT APPEAR");
    expect(JSON.stringify(narrowed)).not.toContain("12345");
  });

  it("refuses a missing mandatory claim rather than issuing a partial attestation", () => {
    expectRefusal(
      () => narrowToDeclaredClaims({ birthdate: "1990-01-01" }, credentialType()),
      /mandatory/i,
    );
  });

  it("refuses a wrong value type, including a locale-formatted date", () => {
    expectRefusal(
      () =>
        narrowToDeclaredClaims(
          { employee_id: "E-1", birthdate: "01/01/1990" },
          credentialType(),
        ),
      /type/i,
    );
    expectRefusal(
      () =>
        narrowToDeclaredClaims({ employee_id: 42, birthdate: "1990-01-01" }, credentialType()),
      /type/i,
    );
  });

  it("never puts a value in the error detail, only the path", () => {
    try {
      narrowToDeclaredClaims(
        { employee_id: "SENSITIVE-VALUE", birthdate: "01/01/1990" },
        credentialType(),
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      const serialised = JSON.stringify(error, Object.getOwnPropertyNames(error));
      expect(serialised).toContain("birthdate");
      expect(serialised).not.toContain("01/01/1990");
    }
  });

  it("omits an absent optional claim without complaining", () => {
    const type = credentialType({
      claims: [
        {
          path: ["employee_id"],
          display: [{ lang: "en", value: "x" }],
          mandatory: true,
          valueType: "string",
        },
        {
          path: ["nickname"],
          display: [{ lang: "en", value: "y" }],
          mandatory: false,
          valueType: "string",
        },
      ],
    });
    expect(narrowToDeclaredClaims({ employee_id: "E-1" }, type)).toEqual({
      employee_id: "E-1",
    });
  });

  it("rebuilds nested structure rather than flattening it", () => {
    const type = credentialType({
      claims: [
        {
          path: ["address", "locality"],
          display: [{ lang: "en", value: "Town" }],
          mandatory: true,
          valueType: "string",
        },
      ],
    });
    expect(
      narrowToDeclaredClaims({ address: { locality: "Utrecht", street: "drop me" } }, type),
    ).toEqual({ address: { locality: "Utrecht" } });
  });
});

// ---------------------------------------------------------------------------------------
describe("issuance plan compilation", () => {
  const version: IssuancePolicyVersion = {
    policyId: "policy-1",
    version: 1,
    status: "PUBLISHED",
    credentialTypeId: "type-1",
    purpose: [{ lang: "en", value: "Issue a badge" }],
    eligibilityRule: { evaluator: "AlwaysEligible", parameters: {} },
    authenticSource: { connector: "fixture", parameters: {} },
    holderBinding: "KEY_BOUND",
    flow: "PRE_AUTHORIZED_CODE",
    credentialValiditySeconds: 3_600,
    statusPolicy: { statusListEnabled: true, suspensionAllowed: false },
    retentionPolicy: defaultRetentionPolicy(),
    createdAt: at,
    publishedAt: at,
  };
  const provider = {
    id: "provider-1",
    tenantId: asId<"TenantId">("11111111-1111-1111-1111-111111111111"),
    organisationId: asId<"OrganisationId">("22222222-2222-2222-2222-222222222222"),
    registrarAssignedIdentifier: "NLAP.0001",
    trustEnvironment: "TEST" as const,
    createdAt: at,
  };
  const providerContext = {
    attestationProviderIdentifier: "NLAP.0001",
    signingKeyBindingRef: "key-1",
    engineTenantRef: "tenant-engine-1",
  };

  it("compiles a published version and deep-freezes the result", () => {
    const plan = compileIssuancePolicy({
      policyVersion: version,
      credentialType: credentialType(),
      attestationProvider: provider,
      providerContext,
      at,
    });
    expect(plan.credential.vct).toBe("urn:edtp:employee-badge:1");
    expect(plan.claimPathsToFetch).toEqual(["employee_id", "birthdate"]);
    expect(plan.credential.rulebookIdentifier).toBe(rulebook.identifier);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.credential)).toBe(true);
  });

  it("refuses a draft version", () => {
    expectRefusal(
      () =>
        compileIssuancePolicy({
          policyVersion: { ...version, status: "DRAFT" },
          credentialType: credentialType(),
          attestationProvider: provider,
          providerContext,
          at,
        }),
      /policy_version_not_published/,
    );
  });

  it("refuses a credential type belonging to another provider", () => {
    expectRefusal(
      () =>
        compileIssuancePolicy({
          policyVersion: version,
          credentialType: credentialType({ attestationProviderId: "someone-else" }),
          attestationProvider: provider,
          providerContext,
          at,
        }),
      /different Attestation Provider/i,
    );
  });

  it("refuses PRODUCTION", () => {
    expectRefusal(
      () =>
        compileIssuancePolicy({
          policyVersion: version,
          credentialType: credentialType(),
          attestationProvider: { ...provider, trustEnvironment: "PRODUCTION" },
          providerContext,
          at,
        }),
      /TEST/i,
    );
  });

  it("reports the registration-certificate omission rather than hiding it", () => {
    const withoutCert = compileIssuancePolicy({
      policyVersion: version,
      credentialType: credentialType(),
      attestationProvider: provider,
      providerContext,
      at,
    });
    expect(withoutCert.providerContext.registrationCertificateJwt).toBeUndefined();

    const withCert = compileIssuancePolicy({
      policyVersion: version,
      credentialType: credentialType(),
      attestationProvider: provider,
      providerContext: { ...providerContext, registrationCertificateJwt: "a.b.c" },
      at,
    });
    expect(withCert.providerContext.registrationCertificateJwt).toBe("a.b.c");
  });
});

// ---------------------------------------------------------------------------------------
describe("trust anchor publication — ARF §6.3.2.4, ETSI TS 119 602", () => {
  const publication = (
    overrides: Partial<TrustAnchorPublication> = {},
  ): TrustAnchorPublication => ({
    id: "pub-1",
    tenantId: "tenant-1",
    trustEnvironment: "TEST",
    schemeOperatorName: "EDTP Development",
    publicationUri: "https://trust.example/eaa-providers.jwt",
    sequenceNumber: 1,
    issuedAt: at,
    nextUpdate: new Date(at.getTime() + 86_400_000),
    anchors: [
      {
        attestationProviderId: "provider-1",
        serviceName: "EDTP Employee Badge Issuance (TEST)",
        certificateDer: "MIIBdummybase64",
        attestationTypes: ["urn:edtp:employee-badge:1"],
        status: "granted",
        statusStartingTime: at,
      },
    ],
    signingKey: { keyBindingRef: "trust-list-key-1", usage: "trustList" },
    createdAt: at,
    ...overrides,
  });

  it("refuses a PRODUCTION publication structurally, not by convention", () => {
    // A PRODUCTION list is a standing trust assertion third parties could rely on. V0 has none of
    // the governance that would justify one.
    expectRefusal(
      () => assertPublishable(publication({ trustEnvironment: "PRODUCTION" })),
      /TEST trust-anchor list only/i,
    );
  });

  it("labels a TEST list inside the signed payload, where it cannot be stripped", () => {
    const body = buildTrustAnchorListBody(publication());
    const lote = (body as { LoTE: TrustListBody }).LoTE;
    const schemeName = lote.ListAndSchemeInformation.SchemeName[0];
    expect(schemeName, "the list must carry a scheme name").toBeDefined();
    expect(schemeName?.value).toContain(TEST_SCHEME_NAME_PREFIX);
    // And says plainly what it is not.
    expect(JSON.stringify(lote.ListAndSchemeInformation.SchemeTypeCommunityRules)).toMatch(
      /NOT a list notified under Topic 31/i,
    );
  });

  it("produces the same shape the platform already consumes", () => {
    // Producer and consumer share a reader, which is the cheapest way to keep them honest.
    const body = buildTrustAnchorListBody(publication()) as { LoTE: TrustListBody };
    const entity = body.LoTE.TrustedEntitiesList[0];
    expect(entity, "the list must carry a trusted entity").toBeDefined();
    const service = entity?.TrustedEntityServices[0]?.ServiceInformation;
    expect(service, "the entity must carry a service").toBeDefined();
    expect(service?.ServiceTypeIdentifier).toMatch(/Issuance$/);
    expect(service?.ServiceDigitalIdentity.X509Certificates[0]?.val).toBe("MIIBdummybase64");
    expect(service?.ServiceStatus).toBe("granted");
  });

  it("refuses an anchor with no attestation types, because that is a blanket authorisation", () => {
    expectRefusal(
      () =>
        assertPublishable(
          publication({
            anchors: publication().anchors.map((a) => ({ ...a, attestationTypes: [] })),
          }),
        ),
      /attestation types/i,
    );
  });

  it("refuses an empty list, a plaintext URI, and a NextUpdate that is already past", () => {
    expectRefusal(() => assertPublishable(publication({ anchors: [] })), /no anchors/i);
    expectRefusal(
      () => assertPublishable(publication({ publicationUri: "http://trust.example/x.jwt" })),
      /HTTPS/i,
    );
    expectRefusal(
      () => assertPublishable(publication({ nextUpdate: new Date(at.getTime() - 1000) })),
      /NextUpdate/i,
    );
  });

  it("refuses an attestation or access key for list signing — a compile error and a runtime one", () => {
    // The whole point of the separation: one compromised key must not be able to forge both the
    // attestations and the list that says which attestations to trust.
    for (const usage of ["attestation", "access", "statusList", "encrypt"] as const) {
      expectRefusal(
        () => assertTrustListSigningKey({ keyBindingRef: "shared-key", usage }),
        /trust_list_signing_key_wrong_usage/,
      );
    }
    expect(() =>
      assertTrustListSigningKey({ keyBindingRef: "trust-list-key-1", usage: "trustList" }),
    ).not.toThrow();
  });

  it("refuses a trustList key whose reference is already used elsewhere", () => {
    // The subtle case: the right usage type, but the engine will let two configurations point at one
    // key chain, so the reference must be distinct too.
    expectRefusal(
      () =>
        assertTrustListSigningKey(
          { keyBindingRef: "shared-chain", usage: "trustList" },
          { attestationKeyRefs: ["shared-chain"] },
        ),
      /trust_list_signing_key_reused/,
    );
    expectRefusal(
      () =>
        assertTrustListSigningKey(
          { keyBindingRef: "shared-chain", usage: "trustList" },
          { accessKeyRefs: ["shared-chain"] },
        ),
      /trust_list_signing_key_reused/,
    );
  });

  it("refuses an empty signing key reference rather than producing an unsigned list", () => {
    expectRefusal(
      () => assertTrustListSigningKey({ keyBindingRef: "   ", usage: "trustList" }),
      /trust_list_signing_key_missing/,
    );
  });

  it("checks the key before anything else, so a wrong key is not reported as a validation problem", () => {
    // A publication with both a wrong key and an empty anchor list must complain about the key: it
    // is a different and worse kind of mistake.
    expectRefusal(
      () =>
        assertPublishable({
          ...publication({ anchors: [] }),
          signingKey: { keyBindingRef: "k", usage: "attestation" },
        }),
      /trust_list_signing_key_wrong_usage/,
    );
  });

  it("reports staleness, which is how a withdrawn anchor stops being trusted", () => {
    const p = publication();
    expect(isPublicationStale(p, at)).toBe(false);
    expect(isPublicationStale(p, new Date(p.nextUpdate.getTime() + 1))).toBe(true);
  });
});
