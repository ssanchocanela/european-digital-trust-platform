import { createHash, generateKeyPairSync, sign, X509Certificate } from "node:crypto";
import {
  type CredentialClaimDefinition,
  defaultRetentionPolicy,
  validateCredentialType,
  validateIssuancePolicyVersion,
} from "@edtp/domain";
import type { EudiIssuerProvisioningPort } from "@edtp/eudi-issuer-port";
import type { EudiVerifierProvisioningPort } from "@edtp/eudi-verifier-port";
import type {
  IssuanceRepository,
  SandboxCertificateRepository,
  SandboxIssuerRepository,
  SandboxRepository,
} from "@edtp/persistence";
import {
  basicConstraints,
  issueCertificate,
  issuePidSigningCertificate,
  keyUsage,
  OID,
  PID_VARIANT_INFO,
  type PidSigningVariant,
  randomSerial,
  serialToHex,
  toPem,
  WRPRC_VARIANT_INFO,
  type WrprcVariant,
} from "@edtp/sandbox-pki";
import { type Clock, newUuid, PlatformError, type TenantId } from "@edtp/shared";
import type { AuditService } from "../audit/audit.service.js";
import { EngineTenantService } from "../engine-tenants/engine-tenant.service.js";
import type { IssuanceService } from "../issuances/issuance.service.js";
import type { SandboxCertificateService } from "./certificates.service.js";
import type { SandboxService, SignedInContext } from "./sandbox.service.js";
import type { SandboxTrustDomain } from "./trust-domain.runtime.js";

/**
 * The hosted PID issuer (S5, specification J7 and J8): an Attestation Provider for the participant's
 * PID Provider service, on an engine tenant of its own, signing PIDs with a certificate the sandbox
 * PID CA issued (D2) — correct, or with a defect from §5.3.
 *
 * What it issues are **synthetic** PIDs: the participant types the values, which pass through as
 * content to the engine and are never stored by the platform. They are signed under a TEST CA and are
 * not PIDs of any Member State.
 *
 * As for the hosted verifier, defects are sent on purpose: no signing-certificate validity is
 * recorded on the provider (the platform would otherwise refuse PID-02), and the provider's WRPRC is
 * published as the engine's unsigned `issuer_info` whatever its variant. **The issuance-side
 * registration checks are not exercised** (G-10): the engine signs no issuer metadata, the sandbox
 * wallet build carries WD-2, and WD-2 switches those checks off (CLAUDE.md §6.21).
 */
export interface IssuerSettings {
  /** The id under which the issuer adapter expects the Wallet Provider list, if it requires one. */
  readonly walletProviderTrustListId?: string;
}

/** PID Rulebook, as pinned in CLAUDE.md §2. */
const RULEBOOK_COMMIT = "36f8adcf914ac06cac18d685add04e0a8a06d685";
const PID_VCT = "urn:eudi:pid:1";

/** The PID Rulebook's mandatory set the sandbox issues, with the attributes a participant types. */
const PID_CLAIMS: readonly CredentialClaimDefinition[] = [
  {
    path: ["family_name"],
    display: [{ lang: "en", value: "Family name" }],
    mandatory: true,
    valueType: "string",
  },
  {
    path: ["given_name"],
    display: [{ lang: "en", value: "Given name" }],
    mandatory: true,
    valueType: "string",
  },
  {
    path: ["birthdate"],
    display: [{ lang: "en", value: "Date of birth" }],
    mandatory: true,
    valueType: "date",
  },
  {
    path: ["place_of_birth", "country"],
    display: [{ lang: "en", value: "Country of birth" }],
    mandatory: true,
    valueType: "string",
  },
  {
    path: ["nationalities"],
    display: [{ lang: "en", value: "Nationalities" }],
    mandatory: true,
    valueType: "string[]",
  },
  {
    path: ["issuing_authority"],
    display: [{ lang: "en", value: "Issuing authority" }],
    mandatory: true,
    valueType: "string",
  },
  {
    path: ["issuing_country"],
    display: [{ lang: "en", value: "Issuing country" }],
    mandatory: true,
    valueType: "string",
  },
];

export interface SyntheticPidValues {
  readonly givenName: string;
  readonly familyName: string;
  readonly birthdate: string;
  readonly birthCountry: string;
  readonly nationalities: readonly string[];
}

const fingerprint = (der: Buffer) =>
  createHash("sha256").update(der).digest("hex").toUpperCase();

export class SandboxIssuerService {
  constructor(
    private readonly settings: IssuerSettings,
    private readonly sandbox: SandboxService,
    private readonly people: SandboxRepository,
    private readonly certificates: SandboxCertificateService,
    private readonly sandboxCertificates: SandboxCertificateRepository,
    private readonly repository: SandboxIssuerRepository,
    private readonly issuance: IssuanceRepository,
    private readonly issuances: IssuanceService,
    private readonly issuerProvisioning: EudiIssuerProvisioningPort,
    private readonly verifierProvisioning: EudiVerifierProvisioningPort,
    private readonly engineTenants: EngineTenantService | undefined,
    private readonly domain: SandboxTrustDomain,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private async providerOf(context: SignedInContext, orgId: string, serviceId: string) {
    const membership = this.sandbox.membershipIn(context, orgId);
    const service = await this.sandboxCertificates.service(membership.tenantId, serviceId);
    if (!service) throw PlatformError.notFound("Service");
    if (service.role !== "pid_provider") {
      throw PlatformError.conflict(
        "sandbox_not_a_pid_provider",
        "Only a PID Provider service has a hosted issuer.",
      );
    }
    const organisation = await this.people.findOrganisation(membership.tenantId);
    const platform = await this.sandboxCertificates.organisationIdOf(membership.tenantId);
    if (!organisation || !platform) throw PlatformError.notFound("Organisation");
    return { tenantId: membership.tenantId, service, organisation, platform };
  }

  /** A signing certificate of the chosen variant, for a key generated for the engine. */
  private async signingCertificate(
    tenantId: TenantId,
    serviceId: string,
    variant: PidSigningVariant,
    subject: { legalName: string; tradeName: string; country: string; localIdentifier: string },
  ) {
    const info = PID_VARIANT_INFO[variant];
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const now = this.clock.now();
    const { der, serial } = issuePidSigningCertificate({
      variant,
      subject,
      subjectPublicKey: publicKey,
      issuer: {
        name: this.domain.name(info.issuer),
        signer: await this.domain.signer(info.issuer),
      },
      now,
    });
    const x = new X509Certificate(der);
    const id = newUuid();
    await this.sandboxCertificates.createCertificate({
      id,
      tenantId,
      relyingPartyServiceId: serviceId,
      kind: "PID_SIGNING",
      variant,
      issuerKey: info.issuer,
      serialHex: serialToHex(serial),
      notBefore: new Date(x.validFrom),
      notAfter: new Date(x.validTo),
      body: toPem(der, "CERTIFICATE"),
      fingerprintSha256: fingerprint(der),
      dnsNames: [],
      createdAt: now,
      mode: "hosted",
    });
    return {
      id,
      privateKeyJwk: privateKey.export({ format: "jwk" }) as Record<string, unknown>,
      chain: [
        toPem(der, "CERTIFICATE"),
        toPem(this.domain.certificate(info.issuer), "CERTIFICATE"),
      ],
    };
  }

  /** A trust-list signing key for a fresh engine tenant, and its Wallet Provider list. */
  private async loadWalletProviders(engineTenantRef: string) {
    const listId = this.settings.walletProviderTrustListId;
    if (!listId) return; // the adapter then requires no wallet attestation
    if (this.domain.walletProviderAnchors.length === 0) {
      throw PlatformError.conflict(
        "sandbox_wallet_providers_missing",
        "The issuer requires wallet attestation, and the sandbox holds no Wallet Provider anchors.",
      );
    }
    if (
      !this.verifierProvisioning.ensureTrustListSigningKey ||
      !this.verifierProvisioning.upsertIssuerTrustList
    ) {
      throw PlatformError.conflict(
        "sandbox_engine_lists_unsupported",
        "The engine adapter cannot load trust lists.",
      );
    }
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const name = [
      { type: OID.organizationName, value: "EDTP Sandbox - TEST ONLY" },
      {
        type: OID.commonName,
        value: `EDTP Sandbox engine list key ${engineTenantRef} - TEST ONLY`,
      },
    ];
    const now = this.clock.now();
    const der = issueCertificate(
      {
        serial: randomSerial(),
        issuer: name,
        subject: name,
        notBefore: now,
        notAfter: new Date(now.getTime() + 730 * 86_400_000),
        subjectPublicKey: publicKey,
        extensions: [basicConstraints(false), keyUsage(["digitalSignature"])],
      },
      {
        publicKey,
        sign: (data) => sign("sha256", data, { key: privateKey, dsaEncoding: "der" }),
      },
    );
    await this.verifierProvisioning.ensureTrustListSigningKey(engineTenantRef, {
      description: "EDTP Sandbox engine list key (TEST)",
      privateKeyJwk: privateKey.export({ format: "jwk" }) as Record<string, unknown>,
      certificatePem: toPem(der, "CERTIFICATE"),
    });
    await this.verifierProvisioning.upsertIssuerTrustList(engineTenantRef, {
      listId,
      description: "EUDI development Wallet Providers, carried by the sandbox (TEST)",
      providerType: "wallet-provider",
      issuers: this.domain.walletProviderAnchors.map((a) => ({
        name: a.name,
        certificatePem: toPem(a.certificate, "CERTIFICATE"),
      })),
    });
  }

  /**
   * Configure the hosted issuer: a signing certificate of the chosen variant and a provider WRPRC of
   * the chosen variant, swapped in for the next issuance. The first configuration creates the engine
   * tenant, the Attestation Provider, the PID credential type and the issuance policy.
   */
  async configure(
    context: SignedInContext,
    orgId: string,
    serviceId: string,
    input: {
      readonly signingVariant: PidSigningVariant;
      readonly registrationVariant: WrprcVariant;
    },
  ) {
    const { tenantId, service, organisation, platform } = await this.providerOf(
      context,
      orgId,
      serviceId,
    );
    const rcInfo = WRPRC_VARIANT_INFO[input.registrationVariant];
    if (rcInfo.appliesTo === "service_provider" || rcInfo.takeAwayOnly) {
      throw PlatformError.conflict(
        "sandbox_variant_not_applicable",
        `${input.registrationVariant} is not offered on the hosted issuer${rcInfo.takeAwayOnly ? " (take-away only, G-10)" : ""}.`,
      );
    }
    const subject = {
      legalName: platform.legalName,
      tradeName: service.serviceTradeName,
      country: organisation.country,
      localIdentifier: organisation.localIdentifier,
    };
    const now = this.clock.now();
    const existing = await this.repository.issuer(tenantId, serviceId);
    const engineTenantRef = existing?.engineTenantRef ?? EngineTenantService.newRef("sbx-iss");
    if (!existing) {
      if (!this.engineTenants) {
        throw PlatformError.conflict(
          "sandbox_engine_tenants_unavailable",
          "Hosted issuers need runtime engine tenants, which are not configured.",
        );
      }
      await this.engineTenants.create(
        engineTenantRef,
        `Sandbox PID issuer: ${service.serviceTradeName}`.slice(0, 100),
      );
      await this.loadWalletProviders(engineTenantRef);
    }

    const signing = await this.signingCertificate(
      tenantId,
      serviceId,
      input.signingVariant,
      subject,
    );
    const imported = await this.issuerProvisioning.importSigningCertificate({
      engineTenantRef,
      name: `sandbox ${input.signingVariant} for ${service.serviceIdentifier}`,
      privateKeyJwk: signing.privateKeyJwk,
      certificateChain: signing.chain,
    });
    const wrprc = await this.certificates.issueRegistrationCertificate(
      context,
      orgId,
      serviceId,
      {
        variant: input.registrationVariant,
      },
    );
    const jwt = typeof wrprc.body === "string" ? wrprc.body : undefined;

    let providerId = existing?.attestationProviderId;
    if (!providerId) {
      const created = await this.issuance.createAttestationProvider({
        tenantId,
        organisationId: platform.organisationId,
        registrarAssignedIdentifier: `${organisation.localIdentifier}/${service.serviceIdentifier}`,
        registrar: "EDTP Sandbox (TEST)",
        trustEnvironment: "TEST",
        at: now,
      });
      providerId = created.id;
    }
    // No signing-certificate validity is recorded: the platform would refuse to issue under PID-02,
    // which exists to be issued under.
    await this.issuance.provisionAttestationProvider({
      tenantId,
      attestationProviderId: providerId,
      engineTenantRef,
      signingKeyBindingRef: imported.keyBindingRef,
      ...(jwt ? { registrationCertificateJwt: jwt } : {}),
    });

    if (!existing) {
      const { credentialTypeId, issuancePolicyId } = await this.createTypeAndPolicy(
        tenantId,
        providerId,
        service.serviceTradeName,
        organisation.country,
      );
      await this.repository.createIssuer({
        relyingPartyServiceId: serviceId,
        tenantId,
        engineTenantRef,
        attestationProviderId: providerId,
        credentialTypeId,
        issuancePolicyId,
        signingCertificateId: signing.id,
        registrationCertificateId: wrprc.id,
        configuredAt: now,
        createdAt: now,
      });
    } else {
      await this.repository.setCertificates(tenantId, serviceId, {
        signingCertificateId: signing.id,
        registrationCertificateId: wrprc.id,
        at: now,
      });
    }
    const issuer = await this.repository.issuer(tenantId, serviceId);
    if (!issuer) throw PlatformError.internal("sandbox_issuer_missing");
    // Write the configuration to the engine now, with the new key, so the next offer uses it.
    await this.issuances.provisionPolicy(tenantId, issuer.issuancePolicyId);
    await this.audit.record({
      tenantId,
      actor: "sandbox",
      action: "sandbox.issuer.configured",
      subjectType: "relying_party_service",
      subjectId: serviceId,
      detail: {
        signingVariant: input.signingVariant,
        registrationVariant: input.registrationVariant,
      },
    });
    return this.view(context, orgId, serviceId);
  }

  private async createTypeAndPolicy(
    tenantId: TenantId,
    providerId: string,
    tradeName: string,
    country: string,
  ) {
    const now = this.clock.now();
    const type = {
      attestationProviderId: providerId,
      name: `Sandbox TEST PID — ${tradeName}`.slice(0, 200),
      format: "dc+sd-jwt" as const,
      vct: PID_VCT,
      rulebook: {
        identifier: "urn:eudi:rulebook:pid",
        version: `catalog commit ${RULEBOOK_COMMIT.slice(0, 7)}, document version 1.1`,
        publicationUri: `https://github.com/eu-digital-identity-wallet/eudi-doc-attestation-rulebooks-catalog/blob/${RULEBOOK_COMMIT}/rulebooks/pid/pid-rulebook.md`,
        anchorSource: "RULEBOOK_AND_PUBLISHED_LIST" as const,
      },
      claims: PID_CLAIMS,
      display: [
        { lang: "en", value: `TEST PID — ${tradeName} (sandbox, synthetic)`.slice(0, 200) },
      ],
      validitySeconds: 2_592_000,
      statusMechanism: "TOKEN_STATUS_LIST" as const,
      requiresKeyBinding: true,
    };
    validateCredentialType(type);
    const createdType = await this.issuance.createCredentialType({ tenantId, type, at: now });
    const policy = await this.issuance.createPolicy({
      tenantId,
      credentialTypeId: createdType.id,
      name: "Sandbox synthetic PID",
      at: now,
    });
    const body = {
      credentialTypeId: createdType.id,
      purpose: [{ lang: "en", value: "Issue a synthetic TEST PID in the EDTP sandbox" }],
      eligibilityRule: { evaluator: "AlwaysEligible", parameters: {} },
      authenticSource: {
        connector: "operator-form",
        parameters: {
          fixedClaims: {
            issuing_authority: `${tradeName} (sandbox TEST)`.slice(0, 200),
            issuing_country: country,
          },
        },
      },
      holderBinding: "KEY_BOUND" as const,
      flow: "PRE_AUTHORIZED_CODE" as const,
      credentialValiditySeconds: 604_800,
      statusPolicy: { statusListEnabled: true, suspensionAllowed: false },
      retentionPolicy: defaultRetentionPolicy(),
    };
    const storedType = await this.issuance.findCredentialType(tenantId, createdType.id);
    if (!storedType) throw PlatformError.internal("sandbox_credential_type_missing");
    validateIssuancePolicyVersion(body, {
      credentialType: storedType,
      registeredEvaluators: ["AlwaysEligible"],
      registeredConnectors: ["operator-form"],
      at: now,
    });
    await this.issuance.createVersion({
      tenantId,
      policyId: policy.id,
      body,
      publish: true,
      at: now,
    });
    return { credentialTypeId: createdType.id, issuancePolicyId: policy.id };
  }

  async view(context: SignedInContext, orgId: string, serviceId: string) {
    const { tenantId } = await this.providerOf(context, orgId, serviceId);
    const issuer = await this.repository.issuer(tenantId, serviceId);
    if (!issuer) return { configured: false as const };
    return {
      configured: true as const,
      configuredAt: issuer.configuredAt,
      signingCertificate: await this.describe(tenantId, issuer.signingCertificateId),
      registrationCertificate: await this.certificates.describeById(
        tenantId,
        issuer.registrationCertificateId,
      ),
      issuances: await this.issuancesOf(tenantId, serviceId),
    };
  }

  private async describe(tenantId: TenantId, id: string) {
    const record = await this.sandboxCertificates.certificate(tenantId, id);
    if (!record) throw PlatformError.notFound("Certificate");
    const info = PID_VARIANT_INFO[record.variant as PidSigningVariant];
    return {
      id: record.id,
      kind: record.kind,
      variant: record.variant,
      variantTitle: info.title,
      requirement: info.requirement,
      ...(record.notAfter ? { notAfter: record.notAfter } : {}),
      ...(record.fingerprintSha256 ? { fingerprintSha256: record.fingerprintSha256 } : {}),
      createdAt: record.createdAt,
      ...(record.body ? { body: record.body } : {}),
    };
  }

  private async issuancesOf(tenantId: TenantId, serviceId: string) {
    const records = await this.repository.issuances(tenantId, serviceId);
    return records.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      ...(r.revokedAt ? { revokedAt: r.revokedAt } : {}),
    }));
  }

  // --- issuance --------------------------------------------------------------------------------

  /**
   * An offer for a synthetic PID with the values the participant typed (specification J8). The values
   * are content: validated, handed to the issuance service, and out of scope when this returns.
   */
  async offer(
    context: SignedInContext,
    orgId: string,
    serviceId: string,
    values: SyntheticPidValues,
  ) {
    const { tenantId } = await this.providerOf(context, orgId, serviceId);
    const issuer = await this.repository.issuer(tenantId, serviceId);
    if (!issuer)
      throw PlatformError.conflict(
        "sandbox_issuer_not_configured",
        "Configure the hosted issuer first.",
      );
    const view = await this.issuances.create({
      tenantId,
      policyId: issuer.issuancePolicyId,
      subjectReference: `sandbox-form-${newUuid()}`,
      suppliedAttributes: {
        given_name: values.givenName,
        family_name: values.familyName,
        birthdate: values.birthdate,
        place_of_birth: { country: values.birthCountry },
        nationalities: [...values.nationalities],
      },
      businessReference: "sandbox-pid",
    });
    const id = newUuid();
    await this.repository.createIssuance({
      id,
      tenantId,
      relyingPartyServiceId: serviceId,
      issuanceId: view.issuanceId,
      signingCertificateId: issuer.signingCertificateId,
      registrationCertificateId: issuer.registrationCertificateId,
      createdAt: this.clock.now(),
    });
    return {
      id,
      offerUri: view.interaction?.uri,
      expiresAt: view.expiresAt,
      ...(view.warnings ? { warnings: view.warnings } : {}),
    };
  }

  async issuanceStatus(context: SignedInContext, orgId: string, id: string) {
    const membership = this.sandbox.membershipIn(context, orgId);
    const record = await this.repository.issuance(membership.tenantId, id);
    if (!record) throw PlatformError.notFound("Issuance");
    const view = await this.issuances.get(membership.tenantId, record.issuanceId);
    const issuedCredentialId =
      view.issuedCredentialId ??
      (await this.issuance.findIssuedIdByTransaction(membership.tenantId, record.issuanceId));
    return {
      id: record.id,
      status: view.status,
      ...(view.failureCode ? { failureCode: view.failureCode } : {}),
      revocable: Boolean(issuedCredentialId) && !record.revokedAt,
      ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
      signingCertificate: await this.describe(membership.tenantId, record.signingCertificateId),
    };
  }

  /** PID-03: revoke an issued PID. Final (`AS-AP-07-007`, `VCR_04`). */
  async revoke(context: SignedInContext, orgId: string, id: string) {
    const membership = this.sandbox.membershipIn(context, orgId);
    const record = await this.repository.issuance(membership.tenantId, id);
    if (!record) throw PlatformError.notFound("Issuance");
    if (record.revokedAt)
      throw PlatformError.conflict(
        "sandbox_pid_revoked",
        "Already revoked; revocation is final.",
      );
    const view = await this.issuances.get(membership.tenantId, record.issuanceId);
    const issuedCredentialId =
      view.issuedCredentialId ??
      (await this.issuance.findIssuedIdByTransaction(membership.tenantId, record.issuanceId));
    if (!issuedCredentialId) {
      throw PlatformError.conflict(
        "sandbox_pid_not_issued",
        "Nothing was issued yet, so there is nothing to revoke.",
      );
    }
    await this.issuances.changeCredentialStatus({
      tenantId: membership.tenantId,
      issuedCredentialId,
      to: "REVOKED",
    });
    await this.repository.markRevoked(membership.tenantId, id, this.clock.now());
    return this.issuanceStatus(context, orgId, id);
  }
}
