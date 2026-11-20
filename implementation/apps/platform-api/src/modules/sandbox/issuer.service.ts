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
  SandboxCredentialTypeRecord,
  SandboxCredentialTypeRepository,
  SandboxIssuerRepository,
  SandboxRepository,
  SandboxWalletProviderRepository,
} from "@edtp/persistence";
import { type SandboxCredentialTypeDefinition, shapeClaimValues } from "@edtp/sandbox-domain";
import {
  basicConstraints,
  EAA_VARIANT_INFO,
  type EaaVariant,
  issueCertificate,
  issueEaaSigningCertificate,
  issuePidSigningCertificate,
  keyUsage,
  OID,
  PID_VARIANT_INFO,
  type PidSigningVariant,
  randomSerial,
  serialToHex,
  toPem,
  WRPRC_VARIANT_INFO,
  type WrpacVariant,
  type WrprcVariant,
} from "@edtp/sandbox-pki";
import { type Clock, newUuid, PlatformError, type TenantId } from "@edtp/shared";
import type { AuditService } from "../audit/audit.service.js";
import { EngineTenantService } from "../engine-tenants/engine-tenant.service.js";
import type { IssuanceService } from "../issuances/issuance.service.js";
import type { SandboxCertificateService } from "./certificates.service.js";
import { assertQuota, quotaWindowStart } from "./quotas.js";
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
  /**
   * The engine's public host: the `dNSName` of each hosted issuer's access certificate, which signs
   * its metadata (S5b). The same host the hosted verifier's certificates name.
   */
  readonly metadataDnsName?: string;
  /** The sandbox's public base: where the EAA "Rulebook" (the wallet guide) is published (ADR 0023). */
  readonly publicBase?: string;
}

/** The hosted issuer's role: a PID Provider (S5) or a non-qualified EAA Provider (ADR 0023). */
type ProviderRole = "pid_provider" | "eaa_provider";
type SigningVariant = PidSigningVariant | EaaVariant;

const isEaaVariant = (v: string): v is EaaVariant => v in EAA_VARIANT_INFO;
const variantInfo = (v: string) =>
  isEaaVariant(v) ? EAA_VARIANT_INFO[v] : PID_VARIANT_INFO[v as PidSigningVariant];

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
    /** Participants' approved anchors (ADR 0020). Absent: the operator's files only. */
    private readonly walletProviders?: SandboxWalletProviderRepository,
    /** EAA Providers' credential types (ADR 0023). Absent: no EAA issuers. */
    private readonly credentialTypes?: SandboxCredentialTypeRepository,
  ) {}

  /**
   * What the hosted issuers trust as Wallet Providers: the anchors the operator placed (the EU
   * development Wallet Providers), and every approved participant anchor of an active organisation —
   * the same set the published `WalletProviders` list carries.
   */
  private async walletProviderAnchors() {
    const operator = this.domain.walletProviderAnchors.map((a) => ({
      name: a.name,
      certificatePem: toPem(a.certificate, "CERTIFICATE"),
    }));
    const participants = this.walletProviders
      ? (await this.walletProviders.listed(this.clock.now())).map((a) => ({
          name: `${a.organisation} — ${a.subject}`.slice(0, 200),
          certificatePem: toPem(Buffer.from(a.certificateDer, "base64"), "CERTIFICATE"),
        }))
      : [];
    return [...operator, ...participants];
  }

  /**
   * Rewrite every hosted issuer's Wallet Provider list from the current set (ADR 0020 §4), after an
   * approval, a withdrawal or a suspension. One issuer failing does not stop the others; it is logged
   * by the caller's audit trail and retried at the next change or sweep.
   */
  async refreshWalletProviders(): Promise<{
    readonly refreshed: number;
    readonly failed: number;
  }> {
    const listId = this.settings.walletProviderTrustListId;
    if (!listId || !this.verifierProvisioning.upsertIssuerTrustList) {
      return { refreshed: 0, failed: 0 };
    }
    const issuers = await this.walletProviderAnchors();
    let refreshed = 0;
    let failed = 0;
    for (const ref of await this.repository.allEngineTenantRefs()) {
      try {
        await this.verifierProvisioning.upsertIssuerTrustList(ref, {
          listId,
          description: "Wallet Providers trusted by the sandbox (TEST)",
          providerType: "wallet-provider",
          issuers,
        });
        refreshed++;
      } catch {
        failed++;
      }
    }
    return { refreshed, failed };
  }

  private async providerOf(context: SignedInContext, orgId: string, serviceId: string) {
    const membership = await this.sandbox.activeMembershipIn(context, orgId);
    const service = await this.sandboxCertificates.service(membership.tenantId, serviceId);
    if (!service) throw PlatformError.notFound("Service");
    if (service.role !== "pid_provider" && service.role !== "eaa_provider") {
      throw PlatformError.conflict(
        "sandbox_not_a_pid_provider",
        "Only a PID Provider or an EAA Provider service has a hosted issuer.",
      );
    }
    const organisation = await this.people.findOrganisation(membership.tenantId);
    const platform = await this.sandboxCertificates.organisationIdOf(membership.tenantId);
    if (!organisation || !platform) throw PlatformError.notFound("Organisation");
    const role: ProviderRole = service.role;
    return { tenantId: membership.tenantId, service, organisation, platform, role };
  }

  /** A signing certificate of the chosen variant, for a key generated for the engine. */
  private async signingCertificate(
    tenantId: TenantId,
    serviceId: string,
    variant: SigningVariant,
    subject: { legalName: string; tradeName: string; country: string; localIdentifier: string },
  ) {
    const info = variantInfo(variant);
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const now = this.clock.now();
    const issuer = {
      name: this.domain.name(info.issuer),
      signer: await this.domain.signer(info.issuer),
    };
    const { der, serial } = isEaaVariant(variant)
      ? issueEaaSigningCertificate({
          variant,
          subject,
          subjectPublicKey: publicKey,
          issuer,
          now,
        })
      : issuePidSigningCertificate({
          variant,
          subject,
          subjectPublicKey: publicKey,
          issuer,
          now,
        });
    const x = new X509Certificate(der);
    const id = newUuid();
    await this.sandboxCertificates.createCertificate({
      id,
      tenantId,
      relyingPartyServiceId: serviceId,
      kind: isEaaVariant(variant) ? "EAA_SIGNING" : "PID_SIGNING",
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
    const anchors = await this.walletProviderAnchors();
    if (anchors.length === 0) {
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
      description: "Wallet Providers trusted by the sandbox (TEST)",
      providerType: "wallet-provider",
      issuers: anchors,
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
      readonly signingVariant: SigningVariant;
      readonly registrationVariant: WrprcVariant;
      /** The access certificate that signs the metadata (S5b). AC-00 unless stated. */
      readonly accessVariant?: WrpacVariant;
    },
  ) {
    const { tenantId, service, organisation, platform, role } = await this.providerOf(
      context,
      orgId,
      serviceId,
    );
    if (isEaaVariant(input.signingVariant) !== (role === "eaa_provider")) {
      throw PlatformError.conflict(
        "sandbox_variant_not_applicable",
        role === "eaa_provider"
          ? "An EAA Provider's issuer signs with an EAA-0n variant."
          : "A PID Provider's issuer signs with a PID-0n variant.",
      );
    }
    if (role === "eaa_provider" && (!this.credentialTypes || !this.domain.has("eaa-ca"))) {
      throw PlatformError.conflict(
        "sandbox_eaa_unavailable",
        "EAA issuers are not available on this sandbox yet: its EAA CA has not been created.",
      );
    }
    const rcInfo = WRPRC_VARIANT_INFO[input.registrationVariant];
    if (rcInfo.appliesTo === "service_provider") {
      throw PlatformError.conflict(
        "sandbox_variant_not_applicable",
        `${input.registrationVariant} applies to a Relying Party, not to a provider.`,
      );
    }
    if (!this.settings.metadataDnsName) {
      throw PlatformError.conflict(
        "sandbox_issuer_metadata_unavailable",
        "Hosted issuers need the engine's public host (SANDBOX_VERIFIER_DNS_NAME) for their access certificate.",
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
    if (!existing) {
      assertQuota(
        "hostedIssuersPerOrganisation",
        await this.repository.countIssuers(tenantId, role),
      );
    }
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
        `Sandbox ${role === "eaa_provider" ? "EAA" : "PID"} issuer: ${service.serviceTradeName}`.slice(
          0,
          100,
        ),
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

    // The access certificate that signs this issuer's metadata (ADR 0016): from the sandbox Access CA,
    // its key generated in the sandbox's sealed store, where it stays — the metadata is signed per
    // request, so the key cannot be handed to the engine and forgotten.
    const accessKeyName = `ia-${newUuid().replace(/-/g, "").slice(0, 20)}`;
    const accessKey = await this.domain.createKey(accessKeyName);
    const access = await this.certificates.issueAccessCertificateFor(
      context,
      orgId,
      serviceId,
      {
        variant: input.accessVariant ?? "AC-00",
        publicKey: accessKey.publicKey,
        dnsNames: [this.settings.metadataDnsName],
        mode: "hosted",
      },
    );

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
      // A PID issuer has one type and policy; an EAA issuer's types carry their own (ADR 0023).
      const pid =
        role === "pid_provider"
          ? await this.createTypeAndPolicy(
              tenantId,
              providerId,
              service.serviceTradeName,
              organisation.country,
            )
          : undefined;
      await this.repository.createIssuer({
        relyingPartyServiceId: serviceId,
        tenantId,
        engineTenantRef,
        attestationProviderId: providerId,
        ...(pid ?? {}),
        signingCertificateId: signing.id,
        registrationCertificateId: wrprc.id,
        accessCertificateId: access.id,
        accessKeyName,
        configuredAt: now,
        createdAt: now,
      });
    } else {
      await this.repository.setCertificates(tenantId, serviceId, {
        signingCertificateId: signing.id,
        registrationCertificateId: wrprc.id,
        accessCertificateId: access.id,
        accessKeyName,
        at: now,
      });
    }
    const issuer = await this.repository.issuer(tenantId, serviceId);
    if (!issuer) throw PlatformError.internal("sandbox_issuer_missing");
    // Write the configuration to the engine now, with the new key, so the next offer uses it.
    if (issuer.issuancePolicyId) {
      await this.issuances.provisionPolicy(tenantId, issuer.issuancePolicyId);
    } else {
      await this.provisionEaaTypes(tenantId, serviceId, issuer.attestationProviderId);
    }
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

  // --- EAA types (ADR 0023) ---------------------------------------------------------------------

  /**
   * Make every type's latest version issuable on this service's hosted issuer: a platform credential
   * type and issuance policy per version, the first time, then the engine configuration rewritten with
   * the issuer's current signing key. Older versions keep what they were provisioned with.
   */
  private async provisionEaaTypes(tenantId: TenantId, serviceId: string, providerId: string) {
    if (!this.credentialTypes) return;
    const all = await this.credentialTypes.ofService(tenantId, serviceId);
    const latest = all.filter((t, i) => all.findIndex((x) => x.slug === t.slug) === i);
    for (const t of latest) await this.provisionVersion(tenantId, providerId, t);
  }

  /** A new type version, created after the issuer was configured: issuable at once. */
  async provisionType(
    tenantId: TenantId,
    serviceId: string,
    record: SandboxCredentialTypeRecord,
  ) {
    const issuer = await this.repository.issuer(tenantId, serviceId);
    if (!issuer) return; // configured later: `configure` provisions it then
    await this.provisionVersion(tenantId, issuer.attestationProviderId, record);
  }

  private async provisionVersion(
    tenantId: TenantId,
    providerId: string,
    record: SandboxCredentialTypeRecord,
  ) {
    let policyId = record.issuancePolicyId;
    if (!policyId) {
      const created = await this.createEaaTypeAndPolicy(tenantId, providerId, record);
      await this.credentialTypes?.setProvisioned(tenantId, record.id, created);
      policyId = created.issuancePolicyId;
    }
    await this.issuances.provisionPolicy(tenantId, policyId);
  }

  private async createEaaTypeAndPolicy(
    tenantId: TenantId,
    providerId: string,
    record: SandboxCredentialTypeRecord,
  ) {
    const now = this.clock.now();
    const definition = record.definition as SandboxCredentialTypeDefinition;
    const english = definition.display.find((d) => d.lang === "en") ?? definition.display[0];
    const label = `${english?.value ?? record.slug}`.slice(0, 120);
    const type = {
      attestationProviderId: providerId,
      name: `Sandbox TEST EAA — ${label} v${record.version}`.slice(0, 200),
      format: "dc+sd-jwt" as const,
      vct: record.vct,
      // The sandbox's own "Rulebook" (ADR 0023 §3): its anchors are the sandbox EAA CA, published on
      // the EAA list. Named for what it is; it is not an EUDI catalogue Rulebook.
      rulebook: {
        identifier: "urn:edtp:sandbox:rulebook:non-qualified-eaa",
        version: "ADR 0023",
        ...(this.settings.publicBase
          ? { publicationUri: `${this.settings.publicBase.replace(/\/+$/, "")}/wallets` }
          : {}),
        anchorSource: "RULEBOOK_AND_PUBLISHED_LIST" as const,
      },
      claims: definition.claims.map((c) => ({
        path: [c.name],
        display: c.display,
        mandatory: c.mandatory,
        valueType: c.valueType,
      })),
      display: definition.display.map((d) => ({
        lang: d.lang,
        value: `${d.value} (sandbox TEST)`.slice(0, 200),
      })),
      validitySeconds: definition.validitySeconds,
      statusMechanism: "TOKEN_STATUS_LIST" as const,
      requiresKeyBinding: true,
    };
    validateCredentialType(type);
    const createdType = await this.issuance.createCredentialType({ tenantId, type, at: now });
    const policy = await this.issuance.createPolicy({
      tenantId,
      credentialTypeId: createdType.id,
      name: `Sandbox EAA ${record.slug} v${record.version}`.slice(0, 200),
      at: now,
    });
    const body = {
      credentialTypeId: createdType.id,
      purpose: [{ lang: "en", value: "Issue a synthetic TEST EAA in the EDTP sandbox" }],
      eligibilityRule: { evaluator: "AlwaysEligible", parameters: {} },
      authenticSource: { connector: "operator-form", parameters: {} },
      holderBinding: "KEY_BOUND" as const,
      flow: "PRE_AUTHORIZED_CODE" as const,
      credentialValiditySeconds: definition.validitySeconds,
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

  /**
   * An offer for a synthetic EAA of one of the service's types, with the values the participant typed.
   * The values are content: checked against the type, handed to the issuance service, and out of scope
   * when this returns (CLAUDE.md §5).
   */
  async offerEaa(
    context: SignedInContext,
    orgId: string,
    serviceId: string,
    typeVersionId: string,
    values: Readonly<Record<string, unknown>>,
  ) {
    const { tenantId, role } = await this.providerOf(context, orgId, serviceId);
    if (role !== "eaa_provider" || !this.credentialTypes) {
      throw PlatformError.conflict(
        "sandbox_not_an_eaa_provider",
        "Only an EAA Provider issues EAAs.",
      );
    }
    const issuer = await this.repository.issuer(tenantId, serviceId);
    if (!issuer)
      throw PlatformError.conflict(
        "sandbox_issuer_not_configured",
        "Configure the hosted EAA issuer first.",
      );
    const record = await this.credentialTypes.byId(tenantId, typeVersionId);
    if (!record || record.relyingPartyServiceId !== serviceId) {
      throw PlatformError.notFound("Credential type");
    }
    if (!record.issuancePolicyId)
      await this.provisionVersion(tenantId, issuer.attestationProviderId, record);
    const provisioned = await this.credentialTypes.byId(tenantId, typeVersionId);
    if (!provisioned?.issuancePolicyId)
      throw PlatformError.internal("sandbox_type_not_provisioned");
    const supplied = shapeClaimValues(
      record.definition as SandboxCredentialTypeDefinition,
      values,
    );
    assertQuota(
      "offersPerServicePerDay",
      await this.repository.countIssuancesSince(
        tenantId,
        serviceId,
        quotaWindowStart(this.clock.now()),
      ),
    );
    const view = await this.issuances.create({
      tenantId,
      policyId: provisioned.issuancePolicyId,
      subjectReference: `sandbox-form-${newUuid()}`,
      suppliedAttributes: supplied,
      businessReference: "sandbox-eaa",
    });
    const id = newUuid();
    await this.repository.createIssuance({
      id,
      tenantId,
      relyingPartyServiceId: serviceId,
      issuanceId: view.issuanceId,
      signingCertificateId: issuer.signingCertificateId,
      registrationCertificateId: issuer.registrationCertificateId,
      credentialTypeVersionId: record.id,
      createdAt: this.clock.now(),
    });
    return {
      id,
      offerUri: view.interaction?.uri,
      expiresAt: view.expiresAt,
      ...(view.warnings ? { warnings: view.warnings } : {}),
    };
  }

  async view(context: SignedInContext, orgId: string, serviceId: string) {
    const { tenantId, role } = await this.providerOf(context, orgId, serviceId);
    const issuer = await this.repository.issuer(tenantId, serviceId);
    if (!issuer) return { configured: false as const, role };
    return {
      configured: true as const,
      role,
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
    const info = variantInfo(record.variant);
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
    if (!issuer?.issuancePolicyId)
      throw PlatformError.conflict(
        "sandbox_issuer_not_configured",
        "Configure the hosted PID issuer first.",
      );
    const issuancePolicyId = issuer.issuancePolicyId;
    assertQuota(
      "offersPerServicePerDay",
      await this.repository.countIssuancesSince(
        tenantId,
        serviceId,
        quotaWindowStart(this.clock.now()),
      ),
    );
    const view = await this.issuances.create({
      tenantId,
      policyId: issuancePolicyId,
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
