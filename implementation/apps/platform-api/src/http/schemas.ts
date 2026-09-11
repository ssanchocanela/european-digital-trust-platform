import { z } from "zod";

/**
 * Request schemas.
 *
 * Schema-first validation at the boundary: every request body is parsed before it reaches
 * a service, so a service can assume well-formed input and the rejection message is
 * specific. Nothing is cast.
 *
 * Note what is **absent** from every schema: no DCQL, no `client_id` scheme, no response
 * mode, no engine configuration. Customers work with policies, claims and transactions;
 * protocol structure lives below the ports.
 */

const localisedText = z.object({
  lang: z
    .string()
    .regex(
      /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/,
      "A language tag such as 'en' or 'pt-BR' is required.",
    ),
  value: z.string().min(1).max(2_048),
});

/**
 * An OpenID4VP claims path pointer: strings, nulls and non-negative integers.
 *
 * Modelled as a path rather than a flat attribute name because TS5 `Claim.path` is one, and
 * because the subset check depends on the structure — ADR 0005 Decision 1c.
 */
const claimPath = z
  .array(z.union([z.string().min(1), z.number().int().min(0), z.null()]))
  .min(1)
  .max(16);

const credentialFormat = z.enum(["dc+sd-jwt", "mso_mdoc"]);

export const createTenantSchema = z.object({ name: z.string().min(1).max(200) }).strict();

export const createOrganisationSchema = z
  .object({
    legalName: z.string().min(1).max(500),
    /** ISO 3166-1 alpha-2 Member State of establishment. */
    memberState: z.string().regex(/^[A-Za-z]{2}$/),
    isPublicSectorBody: z.boolean(),
    officialIdentifiers: z
      .array(
        z.object({ scheme: z.string().min(1).max(500), value: z.string().min(1).max(200) }),
      )
      .min(1),
  })
  .strict();

export const createRelyingPartySchema = z
  .object({
    organisationId: z.string().uuid(),
    /** Registrar-assigned and EU-wide unique. Recorded, never minted. */
    registrarAssignedIdentifier: z.string().min(1).max(200),
    registrar: z.string().min(1).max(200),
    registryUri: z.string().url().optional(),
    tradeName: z.string().min(1).max(200).optional(),
    trustEnvironment: z.enum(["TEST", "PRODUCTION"]).default("TEST"),
  })
  .strict();

export const createRelyingPartyServiceSchema = z
  .object({
    relyingPartyId: z.string().uuid(),
    serviceIdentifier: z.string().min(1).max(200),
    serviceTradeName: z.string().min(1).max(200),
    description: z.array(localisedText).min(1),
    /** Exact-match allow-list for result callbacks (SSRF protection). */
    callbackUrlAllowList: z.array(z.string().url()).max(20).default([]),
  })
  .strict();

export const createIntendedUseSchema = z
  .object({
    /** Registrar-provided. Recorded, never minted. */
    intendedUseIdentifier: z.string().min(1).max(200),
    purpose: z.array(localisedText).min(1),
    privacyPolicyUris: z.array(localisedText).min(1),
    registeredCredentials: z
      .array(
        z.object({
          format: credentialFormat,
          vctValues: z.array(z.string().min(1)).optional(),
          doctype: z.string().min(1).optional(),
          claims: z.array(claimPath).min(1),
        }),
      )
      .min(1),
    validFrom: z.coerce.date().optional(),
  })
  .strict();

export const recordRegistrationCertificateSchema = z
  .object({
    intendedUseId: z.string().uuid(),
    /** Optional: V0 has no reachable provider of registration certificates (blocker B3). */
    jwt: z.string().min(1).optional(),
    provider: z.string().min(1).max(200).optional(),
    trustEnvironment: z.enum(["TEST", "PRODUCTION"]).default("TEST"),
  })
  .strict();

/**
 * Provisions the Relying Party Instance and imports its access certificate.
 *
 * The key arrives as a JWK and the chain as PEM because that is what the engine's import
 * endpoint accepts. Both are handled in memory and neither is persisted by the platform:
 * only the opaque key-binding reference the engine returns is stored.
 */
export const provisionInstanceSchema = z
  .object({
    engineTenantRef: z.string().min(1).max(200),
    trustEnvironment: z.enum(["TEST", "PRODUCTION"]).default("TEST"),
    accessCertificate: z.object({
      privateKeyJwk: z.record(z.string(), z.unknown()),
      certificateChain: z.array(z.string().min(1)).min(1),
      subject: z.string().max(500).optional(),
      issuer: z.string().max(500).optional(),
    }),
  })
  .strict();

export const createPolicySchema = z
  .object({
    relyingPartyServiceId: z.string().uuid(),
    intendedUseId: z.string().uuid(),
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(2_000),
  })
  .strict();

const verifiedClaimsResultPolicy = z
  .object({
    kind: z.literal("VERIFIED_CLAIMS"),
    allowedClaims: z.array(claimPath).min(1),
  })
  .strict();

/**
 * Derivations are named with explicit parameters. No expression language and no rules
 * engine — see ADR 0005 Decision 4.
 *
 * `AgeAtLeast` is the V0 transformation, and it is the **primary** route for an age check
 * rather than a fallback: `age_over_18` and `age_over_NN` were removed from the PID by PID
 * Rulebook v1.1 following CIR 2024/2977, and the reference PID issuer advertises no age
 * claim in either format. ADR 0005 Decision 5.
 */
const derivation = z.discriminatedUnion("name", [
  z
    .object({
      name: z.literal("AgeAtLeast"),
      sourcePath: claimPath,
      minimumAgeYears: z.number().int().min(0).max(150),
      outputClaim: z.string().min(1).max(100),
    })
    .strict(),
  z
    .object({
      name: z.literal("ClaimPresence"),
      sourcePath: claimPath,
      outputClaim: z.string().min(1).max(100),
    })
    .strict(),
  z
    .object({
      name: z.literal("ClaimInSet"),
      sourcePath: claimPath,
      allowedValues: z.array(z.string()).min(1).max(200),
      outputClaim: z.string().min(1).max(100),
    })
    .strict(),
]);

const derivedClaimsResultPolicy = z
  .object({
    kind: z.literal("DERIVED_CLAIMS"),
    derivations: z.array(derivation).min(1).max(20),
  })
  .strict();

export const createPolicyVersionSchema = z
  .object({
    purpose: z.array(localisedText).min(1),
    /** Exactly one in V0, modelled as a list so multi-attestation uses need no migration. */
    credentialRequirements: z
      .array(
        z
          .object({
            credentialType: z.string().min(1).max(500),
            acceptedFormats: z.array(credentialFormat).min(1),
          })
          .strict(),
      )
      .length(1),
    requestedClaims: z
      .array(z.object({ path: claimPath }).strict())
      .min(1)
      .max(50),
    resultPolicy: z.union([verifiedClaimsResultPolicy, derivedClaimsResultPolicy]),
    trustPolicy: z
      .object({
        anchorSources: z
          .array(
            z
              .object({
                kind: z.enum(["ETSI_TS_119_602_LOTE", "ETSI_TS_119_612_TRUSTED_LIST"]),
                domain: z.enum([
                  "PID_PROVIDER",
                  "QEAA_PROVIDER",
                  "PUB_EAA_PROVIDER",
                  "EAA_PROVIDER",
                  "ACCESS_CERTIFICATE_PROVIDER",
                  "REGISTRATION_CERTIFICATE_PROVIDER",
                ]),
                ref: z.string().min(1),
              })
              .strict(),
          )
          .default([]),
        statusCheckMode: z.enum(["STRICT", "BEST_EFFORT", "DISABLED"]).default("STRICT"),
      })
      .strict()
      .optional(),
    retentionPolicy: z
      .object({
        transactionLifetimeSeconds: z.number().int().min(60).max(3_600),
        resultRetentionSeconds: z.number().int().min(60).max(2_592_000),
      })
      .strict()
      .optional(),
    publish: z.boolean().default(false),
  })
  .strict();

export const createPresentationSchema = z
  .object({
    policyId: z.string().uuid(),
    /** Defaults to the latest published version. A draft is never resolvable. */
    policyVersion: z.number().int().min(1).optional(),
    businessReference: z.string().min(1).max(200),
    /** Must exactly match a URL registered on the Relying Party Service. */
    callbackUrl: z.string().url().optional(),
    /**
     * `SAME_DEVICE` is the tested V0 path and the default. `QR` is available but flagged:
     * `EW-PIO-01-016` (`OIA_08c`) says Wallet Units SHOULD NOT support redirect-based
     * cross-device flows and `EW-PIO-01-017` (`OIA_08d`) obliges mitigations V0 has not
     * implemented. Requesting it is audited.
     */
    interactionType: z.enum(["SAME_DEVICE", "QR"]).default("SAME_DEVICE"),
  })
  .strict();

export type CreateTenantBody = z.infer<typeof createTenantSchema>;
export type CreateOrganisationBody = z.infer<typeof createOrganisationSchema>;
export type CreateRelyingPartyBody = z.infer<typeof createRelyingPartySchema>;
export type CreateRelyingPartyServiceBody = z.infer<typeof createRelyingPartyServiceSchema>;
export type CreateIntendedUseBody = z.infer<typeof createIntendedUseSchema>;
export type RecordRegistrationCertificateBody = z.infer<
  typeof recordRegistrationCertificateSchema
>;
export type ProvisionInstanceBody = z.infer<typeof provisionInstanceSchema>;
export type CreatePolicyBody = z.infer<typeof createPolicySchema>;
export type CreatePolicyVersionBody = z.infer<typeof createPolicyVersionSchema>;
export type CreatePresentationBody = z.infer<typeof createPresentationSchema>;

// --- Milestone 2: Issuance as a Service -------------------------------------------------

const localisedTextSchema = z.object({
  lang: z.string().min(2).max(16),
  value: z.string().min(1),
});

export const createAttestationProviderSchema = z
  .object({
    organisationId: z.string().uuid(),
    registrarAssignedIdentifier: z.string().min(1).max(200),
    registrar: z.string().min(1).max(200).optional(),
    trustEnvironment: z.enum(["TEST", "PRODUCTION"]).default("TEST"),
  })
  .strict();

/**
 * Provisions the Attestation Provider: its engine tenant, signing key, and optionally the
 * registration certificate published in the Credential Issuer metadata (trust gate a).
 *
 * The key arrives as a JWK and the chain as PEM because that is what the engine's import endpoint
 * accepts. Both are handled in memory; the platform keeps only the opaque key-binding reference.
 */
export const provisionAttestationProviderSchema = z
  .object({
    engineTenantRef: z.string().min(1).max(200),
    signingCertificate: z.object({
      privateKeyJwk: z.record(z.string(), z.unknown()),
      certificateChain: z.array(z.string().min(1)).min(1),
    }),
    /** ARF §6.6.2.2. Absent in V0 (blocker B3); the omission is reported, never faked. */
    registrationCertificateJwt: z.string().min(1).optional(),
  })
  .strict();

export const createCredentialTypeSchema = z
  .object({
    attestationProviderId: z.string().uuid(),
    name: z.string().min(1).max(200),
    format: z.enum(["dc+sd-jwt", "mso_mdoc"]),
    vct: z.string().min(1).max(500).optional(),
    doctype: z.string().min(1).max(500).optional(),
    /**
     * Trust configuration, not documentation: ARF §6.3.2.4 makes the Rulebook the source of trust
     * anchors for verifying a non-qualified EAA's signature.
     */
    rulebook: z.object({
      identifier: z.string().min(1).max(500),
      version: z.string().min(1).max(50),
      publicationUri: z.string().url().optional(),
      anchorSource: z
        .enum(["RULEBOOK_ONLY", "RULEBOOK_AND_PUBLISHED_LIST"])
        .default("RULEBOOK_ONLY"),
    }),
    claims: z
      .array(
        z.object({
          path: z.array(z.string().min(1)).min(1),
          display: z.array(localisedTextSchema).min(1),
          mandatory: z.boolean().default(true),
          valueType: z.enum(["string", "number", "boolean", "date"]),
        }),
      )
      .min(1),
    display: z.array(localisedTextSchema).min(1),
    validitySeconds: z.number().int().positive(),
    statusMechanism: z.enum(["TOKEN_STATUS_LIST", "NONE"]).default("TOKEN_STATUS_LIST"),
    requiresKeyBinding: z.boolean().default(true),
  })
  .strict();

export const createIssuancePolicySchema = z
  .object({
    credentialTypeId: z.string().uuid(),
    name: z.string().min(1).max(200),
  })
  .strict();

export const createIssuancePolicyVersionSchema = z
  .object({
    credentialTypeId: z.string().uuid(),
    purpose: z.array(localisedTextSchema).min(1),
    eligibilityRule: z.object({
      evaluator: z.string().min(1).max(100),
      parameters: z.record(z.string(), z.unknown()).default({}),
    }),
    authenticSource: z.object({
      connector: z.string().min(1).max(100),
      parameters: z.record(z.string(), z.unknown()).default({}),
    }),
    holderBinding: z.enum(["KEY_BOUND", "BEARER"]).default("KEY_BOUND"),
    flow: z.enum(["PRE_AUTHORIZED_CODE", "AUTHORIZATION_CODE"]).default("PRE_AUTHORIZED_CODE"),
    credentialValiditySeconds: z.number().int().positive(),
    statusPolicy: z.object({
      statusListEnabled: z.boolean().default(true),
      suspensionAllowed: z.boolean().default(false),
    }),
    retentionPolicy: z
      .object({
        transactionLifetimeSeconds: z.number().int().positive().default(300),
        resultRetentionSeconds: z.number().int().positive().default(86_400),
      })
      .default({ transactionLifetimeSeconds: 300, resultRetentionSeconds: 86_400 }),
    /** The §7.3 stretch goal: require a PID presentation first, reusing a verification policy. */
    eligibilityPresentationPolicyId: z.string().uuid().optional(),
    publish: z.boolean().default(false),
  })
  .strict();

export const createIssuanceSchema = z
  .object({
    policyId: z.string().uuid(),
    /**
     * A **lookup key** for the authentic source, never attribute values.
     *
     * A client that could pass values directly would make the platform an attestation laundry,
     * issuing claims nobody authoritative asserted.
     */
    subjectReference: z.string().min(1).max(200),
    businessReference: z.string().min(1).max(200).optional(),
    callbackUrl: z.string().url().optional(),
  })
  .strict();

export const changeCredentialStatusSchema = z
  .object({
    /** `VALID` is only reachable from `SUSPENDED`: revocation is irreversible (`VCR_04`). */
    status: z.enum(["VALID", "SUSPENDED", "REVOKED"]),
  })
  .strict();

export type CreateAttestationProviderBody = z.infer<typeof createAttestationProviderSchema>;
export type ProvisionAttestationProviderBody = z.infer<
  typeof provisionAttestationProviderSchema
>;
export type CreateCredentialTypeBody = z.infer<typeof createCredentialTypeSchema>;
export type CreateIssuancePolicyBody = z.infer<typeof createIssuancePolicySchema>;
export type CreateIssuancePolicyVersionBody = z.infer<typeof createIssuancePolicyVersionSchema>;
export type CreateIssuanceBody = z.infer<typeof createIssuanceSchema>;
export type ChangeCredentialStatusBody = z.infer<typeof changeCredentialStatusSchema>;
