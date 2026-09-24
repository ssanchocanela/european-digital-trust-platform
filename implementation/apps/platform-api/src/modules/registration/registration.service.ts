import {
  DEFAULT_TRANSACTION_LIFETIME_SECONDS,
  type IntendedUse,
  isSupportedInV0,
  isValidClaimPath,
  type Organisation,
  type RegisteredCredential,
  type RelyingParty,
  type RelyingPartyService,
  type Tenant,
  type TrustEnvironment,
} from "@edtp/domain";
import type {
  EudiVerifierProvisioningPort,
  ImportAccessCertificateInput,
} from "@edtp/eudi-verifier-port";
import type { ApiKeyRepository, RegistrationRepository } from "@edtp/persistence";
import type { LocalisedText } from "@edtp/shared";
import {
  type Clock,
  type IntendedUseId,
  newAccessCertificateId,
  newIntendedUseId,
  newOpaqueToken,
  newOrganisationId,
  newRegistrationCertificateId,
  newRelyingPartyId,
  newRelyingPartyInstanceId,
  newRelyingPartyServiceId,
  newTenantId,
  newUuid,
  normaliseLocalisedText,
  type OrganisationId,
  PlatformError,
  type RelyingPartyId,
  type RelyingPartyServiceId,
  type TenantId,
} from "@edtp/shared";
import type { AuditService } from "../audit/audit.service.js";

/**
 * Tenancy and registration.
 *
 * The guard running in front of every call has already resolved the tenant from the
 * authenticated credential, so nothing here derives tenancy from input.
 *
 * One rule is enforced in every method that touches trust material: **V0 accepts `TEST`
 * only.** A `PRODUCTION` record is refused rather than stored, because production
 * registration, certificates and Registrar interactions are not faked and the legal
 * qualification of the hosted Relying Party Instance profile is still open (question Q2).
 */
export class RegistrationService {
  constructor(
    private readonly registration: RegistrationRepository,
    private readonly apiKeys: ApiKeyRepository,
    private readonly provisioning: EudiVerifierProvisioningPort,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private assertV0Environment(env: TrustEnvironment): void {
    if (!isSupportedInV0(env)) {
      throw PlatformError.unprocessable(
        "trust_environment_not_supported",
        "V0 supports the TEST trust environment only. Production registration, certificates " +
          "and Registrar interactions are not simulated.",
      );
    }
  }

  async createTenant(
    name: string,
  ): Promise<{ readonly tenant: Tenant; readonly apiKey: string }> {
    const now = this.clock.now();
    const tenant: Tenant = { id: newTenantId(), name, createdAt: now };
    await this.registration.createTenant(tenant);

    // Returned exactly once and stored only as a hash, so it cannot be recovered later.
    const apiKey = `edtp_${newOpaqueToken(32)}`;
    await this.apiKeys.create({
      id: newUuid(),
      tenantId: tenant.id,
      key: apiKey,
      label: "initial tenant key",
      createdAt: now,
    });

    await this.audit.record({
      tenantId: tenant.id,
      actor: "admin",
      action: "tenant.created",
      subjectType: "tenant",
      subjectId: tenant.id,
    });
    return { tenant, apiKey };
  }

  async getTenant(tenantId: TenantId): Promise<Tenant> {
    const tenant = await this.registration.findTenant(tenantId);
    if (!tenant) throw PlatformError.notFound("Tenant");
    return tenant;
  }

  async createOrganisation(input: {
    readonly tenantId: TenantId;
    readonly legalName: string;
    readonly memberState: string;
    readonly isPublicSectorBody: boolean;
    readonly officialIdentifiers: readonly {
      readonly scheme: string;
      readonly value: string;
    }[];
  }): Promise<Organisation> {
    if (input.officialIdentifiers.length === 0) {
      // TS5 §2.4.3.1: at least one identifier must be registered, with the European
      // unique identifier (EUID) as the default scheme where it is available.
      throw PlatformError.unprocessable(
        "official_identifier_required",
        "At least one official identifier is required for an Organisation.",
      );
    }
    const organisation: Organisation = {
      id: newOrganisationId(),
      tenantId: input.tenantId,
      legalName: input.legalName,
      officialIdentifiers: input.officialIdentifiers,
      memberState: input.memberState.toUpperCase(),
      isPublicSectorBody: input.isPublicSectorBody,
      createdAt: this.clock.now(),
    };
    await this.registration.createOrganisation(organisation);
    await this.audit.record({
      tenantId: input.tenantId,
      actor: "tenant",
      action: "organisation.created",
      subjectType: "organisation",
      subjectId: organisation.id,
    });
    return organisation;
  }

  async createRelyingParty(input: {
    readonly tenantId: TenantId;
    readonly organisationId: OrganisationId;
    readonly registrarAssignedIdentifier: string;
    readonly registrar: string;
    readonly registryUri?: string;
    readonly tradeName?: string;
    readonly trustEnvironment: TrustEnvironment;
  }): Promise<RelyingParty> {
    this.assertV0Environment(input.trustEnvironment);
    const organisation = await this.registration.findOrganisation(
      input.tenantId,
      input.organisationId,
    );
    if (!organisation) throw PlatformError.notFound("Organisation");

    const relyingParty: RelyingParty = {
      id: newRelyingPartyId(),
      tenantId: input.tenantId,
      organisationId: input.organisationId,
      // ARF §3.11.1 and `AS-MS-27-043` (`Reg_32`): assigned by the Registrar, EU-wide
      // unique, and identical in the access and registration certificates. The platform
      // records it and never mints it.
      registrarAssignedIdentifier: input.registrarAssignedIdentifier,
      registrar: input.registrar,
      ...(input.registryUri ? { registryUri: input.registryUri } : {}),
      ...(input.tradeName ? { tradeName: input.tradeName } : {}),
      trustEnvironment: input.trustEnvironment,
      createdAt: this.clock.now(),
    };
    await this.registration.createRelyingParty(relyingParty);
    await this.audit.record({
      tenantId: input.tenantId,
      actor: "tenant",
      action: "relying_party.registered",
      subjectType: "relying_party",
      subjectId: relyingParty.id,
      detail: { trustEnvironment: input.trustEnvironment },
    });
    return relyingParty;
  }

  async createRelyingPartyService(input: {
    readonly tenantId: TenantId;
    readonly relyingPartyId: RelyingPartyId;
    readonly serviceIdentifier: string;
    readonly serviceTradeName: string;
    readonly description: readonly LocalisedText[];
    readonly callbackUrlAllowList: readonly string[];
  }): Promise<{ readonly service: RelyingPartyService; readonly webhookSecret: string }> {
    const relyingParty = await this.registration.findRelyingParty(
      input.tenantId,
      input.relyingPartyId,
    );
    if (!relyingParty) throw PlatformError.notFound("Relying Party");

    for (const url of input.callbackUrlAllowList) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw PlatformError.unprocessable(
          "invalid_callback_url",
          `'${url}' in the callback allow-list is not a valid URL.`,
        );
      }
      if (parsed.protocol !== "https:") {
        throw PlatformError.unprocessable(
          "callback_url_not_https",
          "Every callback URL in the allow-list must use HTTPS.",
        );
      }
    }

    const service: RelyingPartyService = {
      id: newRelyingPartyServiceId(),
      tenantId: input.tenantId,
      relyingPartyId: input.relyingPartyId,
      // ARF §3.11.2: RP-chosen and unique within the Relying Party. TS5 makes it
      // optional; the platform requires it — ADR 0005 Decision 1d.
      serviceIdentifier: input.serviceIdentifier,
      serviceTradeName: input.serviceTradeName,
      description: normaliseLocalisedText(input.description),
      callbackUrlAllowList: input.callbackUrlAllowList,
      createdAt: this.clock.now(),
    };
    // Returned once; used to sign outbound result callbacks.
    const webhookSecret = newOpaqueToken(32);
    await this.registration.createRelyingPartyService(service, webhookSecret);
    await this.audit.record({
      tenantId: input.tenantId,
      actor: "tenant",
      action: "relying_party_service.registered",
      subjectType: "relying_party_service",
      subjectId: service.id,
    });
    return { service, webhookSecret };
  }

  async getService(
    tenantId: TenantId,
    serviceId: RelyingPartyServiceId,
  ): Promise<RelyingPartyService> {
    const service = await this.registration.findRelyingPartyService(tenantId, serviceId);
    if (!service) throw PlatformError.notFound("Relying Party Service");
    return service;
  }

  async createIntendedUse(input: {
    readonly tenantId: TenantId;
    readonly relyingPartyServiceId: RelyingPartyServiceId;
    readonly intendedUseIdentifier: string;
    readonly purpose: readonly LocalisedText[];
    readonly privacyPolicyUris: readonly LocalisedText[];
    readonly registeredCredentials: readonly RegisteredCredential[];
    readonly validFrom?: Date;
  }): Promise<IntendedUse> {
    const service = await this.registration.findRelyingPartyService(
      input.tenantId,
      input.relyingPartyServiceId,
    );
    if (!service) throw PlatformError.notFound("Relying Party Service");

    // TS5 makes `purpose` and `privacyPolicy` `[1..*]`, and `AS-WP-06-015` (`RPA_10`)
    // makes the Wallet display both to the User. Neither may be empty.
    if (input.purpose.length === 0) {
      throw PlatformError.unprocessable(
        "purpose_required",
        "At least one localised purpose is required; the Wallet displays it to the User.",
      );
    }
    if (input.privacyPolicyUris.length === 0) {
      throw PlatformError.unprocessable(
        "privacy_policy_required",
        "At least one localised privacy policy URI is required; the Wallet links it for the User.",
      );
    }
    if (input.registeredCredentials.length === 0) {
      throw PlatformError.unprocessable(
        "registered_credentials_required",
        "At least one registered credential is required for an intended use.",
      );
    }

    for (const credential of input.registeredCredentials) {
      if (credential.claims.length === 0) {
        throw PlatformError.unprocessable(
          "registered_claims_required",
          "Each registered credential must register at least one claim.",
        );
      }
      for (const path of credential.claims) {
        if (!isValidClaimPath(path)) {
          throw PlatformError.unprocessable(
            "invalid_claim_path",
            "A registered claim path must be a non-empty array of strings, nulls and " +
              "non-negative integers.",
          );
        }
      }
      if (credential.format === "dc+sd-jwt" && (credential.vctValues ?? []).length === 0) {
        throw PlatformError.unprocessable(
          "credential_type_required",
          "A dc+sd-jwt registered credential must declare at least one credential type.",
        );
      }
      if (credential.format === "mso_mdoc" && !credential.doctype) {
        throw PlatformError.unprocessable(
          "doctype_required",
          "An mso_mdoc registered credential must declare a document type.",
        );
      }
    }

    const intendedUse: IntendedUse = {
      id: newIntendedUseId(),
      tenantId: input.tenantId,
      relyingPartyServiceId: input.relyingPartyServiceId,
      // TS5 `intendedUseIdentifier` is Registrar-provided. Recorded, never minted.
      intendedUseIdentifier: input.intendedUseIdentifier,
      purpose: normaliseLocalisedText(input.purpose),
      privacyPolicyUris: normaliseLocalisedText(input.privacyPolicyUris),
      registeredCredentials: input.registeredCredentials,
      validFrom: input.validFrom ?? this.clock.now(),
      createdAt: this.clock.now(),
    };
    await this.registration.createIntendedUse(intendedUse);
    await this.audit.record({
      tenantId: input.tenantId,
      actor: "tenant",
      action: "intended_use.registered",
      subjectType: "intended_use",
      subjectId: intendedUse.id,
    });
    return intendedUse;
  }

  /**
   * Records a registration certificate for one intended use of one Service.
   *
   * `EW-DM-44-014` (`RPRC_09`) makes that pairing one-to-one, and the unique index
   * enforces it. The JWT is optional because V0 has no reachable provider (blocker B3): a
   * row without one records that the certificate is missing, and the compiler then
   * produces a plan with no registration certificate and the omission is reported.
   */
  async recordRegistrationCertificate(input: {
    readonly tenantId: TenantId;
    readonly relyingPartyServiceId: RelyingPartyServiceId;
    readonly intendedUseId: IntendedUseId;
    readonly jwt?: string;
    readonly provider?: string;
    readonly trustEnvironment: TrustEnvironment;
  }): Promise<void> {
    this.assertV0Environment(input.trustEnvironment);
    const intendedUse = await this.registration.findIntendedUse(
      input.tenantId,
      input.intendedUseId,
    );
    if (!intendedUse) throw PlatformError.notFound("Intended use");
    if (intendedUse.relyingPartyServiceId !== input.relyingPartyServiceId) {
      throw PlatformError.conflict(
        "intended_use_service_mismatch",
        "The intended use does not belong to that Relying Party Service.",
      );
    }

    await this.registration.createRegistrationCertificate({
      id: newRegistrationCertificateId(),
      tenantId: input.tenantId,
      relyingPartyServiceId: input.relyingPartyServiceId,
      intendedUseId: input.intendedUseId,
      ...(input.jwt ? { jwt: input.jwt } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      trustEnvironment: input.trustEnvironment,
      createdAt: this.clock.now(),
    });
    await this.audit.record({
      tenantId: input.tenantId,
      actor: "tenant",
      action: "registration_certificate.recorded",
      subjectType: "intended_use",
      subjectId: input.intendedUseId,
      detail: { hasJwt: input.jwt !== undefined },
    });
  }

  /**
   * Provisions the Relying Party Instance and imports its access certificate.
   *
   * One engine tenant per Relying Party Instance, i.e. per Service and environment
   * (ADR 0002 Decision 3), because the engine scopes key material, certificates and
   * registrar configuration per tenant while ARF scopes those to a Service.
   *
   * The retention settings are applied and asserted here, so no engine tenant can serve a
   * transaction while still on the engine's 24-hour default session TTL (ADR 0004).
   */
  async provisionInstance(input: {
    readonly tenantId: TenantId;
    readonly relyingPartyServiceId: RelyingPartyServiceId;
    readonly engineTenantRef: string;
    readonly trustEnvironment: TrustEnvironment;
    readonly accessCertificate: {
      readonly privateKeyJwk: Readonly<Record<string, unknown>>;
      readonly certificateChain: readonly string[];
      readonly subject?: string;
      readonly issuer?: string;
    };
  }): Promise<{ readonly keyBindingRef: string }> {
    this.assertV0Environment(input.trustEnvironment);
    const service = await this.registration.findRelyingPartyService(
      input.tenantId,
      input.relyingPartyServiceId,
    );
    if (!service) throw PlatformError.notFound("Relying Party Service");

    const importInput: ImportAccessCertificateInput = {
      engineTenantRef: input.engineTenantRef,
      name: `access certificate for service ${service.serviceIdentifier}`,
      privateKeyJwk: input.accessCertificate.privateKeyJwk,
      certificateChain: input.accessCertificate.certificateChain,
    };
    const { keyBindingRef } = await this.provisioning.importAccessCertificate(importInput);

    await this.provisioning.applyRetentionSettings(input.engineTenantRef, {
      sessionTtlSeconds: DEFAULT_TRANSACTION_LIFETIME_SECONDS,
      cleanupMode: "ANONYMIZE",
    });

    const now = this.clock.now();
    await this.registration.createRelyingPartyInstance({
      id: newRelyingPartyInstanceId(),
      tenantId: input.tenantId,
      relyingPartyServiceId: input.relyingPartyServiceId,
      engineTenantRef: input.engineTenantRef,
      trustEnvironment: input.trustEnvironment,
      createdAt: now,
    });
    await this.registration.createAccessCertificate({
      id: newAccessCertificateId(),
      tenantId: input.tenantId,
      relyingPartyId: service.relyingPartyId,
      relyingPartyServiceId: input.relyingPartyServiceId,
      // Only the opaque reference is stored. No private key material reaches the platform
      // database, so there is none to protect, dump or log.
      keyBindingRef,
      ...(input.accessCertificate.subject ? { subject: input.accessCertificate.subject } : {}),
      ...(input.accessCertificate.issuer ? { issuer: input.accessCertificate.issuer } : {}),
      trustEnvironment: input.trustEnvironment,
      createdAt: now,
    });

    await this.audit.record({
      tenantId: input.tenantId,
      actor: "tenant",
      action: "relying_party_instance.provisioned",
      subjectType: "relying_party_service",
      subjectId: input.relyingPartyServiceId,
      detail: { trustEnvironment: input.trustEnvironment, keyBindingRef },
    });

    return { keyBindingRef };
  }
}
