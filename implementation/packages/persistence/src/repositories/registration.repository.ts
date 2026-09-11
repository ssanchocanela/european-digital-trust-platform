import type {
  AccessCertificate,
  IntendedUse,
  Organisation,
  RegistrationCertificate,
  RelyingParty,
  RelyingPartyInstance,
  RelyingPartyService,
  Tenant,
  TrustEnvironment,
} from "@edtp/domain";
import type {
  IntendedUseId,
  OrganisationId,
  RelyingPartyId,
  RelyingPartyServiceId,
  TenantId,
  WebhookEndpointId,
} from "@edtp/shared";
import { asId, PlatformError } from "@edtp/shared";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db.js";
import {
  accessCertificates,
  intendedUses,
  organisations,
  registrationCertificates,
  relyingParties,
  relyingPartyInstances,
  relyingPartyServices,
  tenants,
} from "../schema.js";

/**
 * Repositories for the shared kernel.
 *
 * **Every read and write is tenant-scoped.** A row belonging to another tenant is not
 * "forbidden", it is invisible: the `tenant_id` predicate is part of the query, so a
 * cross-tenant lookup returns nothing and the caller raises a 404. That makes the
 * isolation a property of the query rather than of a later authorisation check, and the
 * cross-tenant tests assert it.
 */
export class RegistrationRepository {
  constructor(private readonly db: Database) {}

  // --- tenants -------------------------------------------------------------

  async createTenant(tenant: Tenant): Promise<Tenant> {
    await this.db.insert(tenants).values({
      id: tenant.id,
      name: tenant.name,
      createdAt: tenant.createdAt,
    });
    return tenant;
  }

  async findTenant(id: TenantId): Promise<Tenant | undefined> {
    const [row] = await this.db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    return row
      ? { id: asId<"TenantId">(row.id), name: row.name, createdAt: row.createdAt }
      : undefined;
  }

  // --- organisations -------------------------------------------------------

  async createOrganisation(o: Organisation): Promise<Organisation> {
    await this.db.insert(organisations).values({
      id: o.id,
      tenantId: o.tenantId,
      legalName: o.legalName,
      officialIdentifiers: o.officialIdentifiers,
      memberState: o.memberState,
      isPublicSectorBody: o.isPublicSectorBody,
      createdAt: o.createdAt,
    });
    return o;
  }

  async findOrganisation(
    tenantId: TenantId,
    id: OrganisationId,
  ): Promise<Organisation | undefined> {
    const [row] = await this.db
      .select()
      .from(organisations)
      .where(and(eq(organisations.tenantId, tenantId), eq(organisations.id, id)))
      .limit(1);
    if (!row) return undefined;
    return {
      id: asId<"OrganisationId">(row.id),
      tenantId: asId<"TenantId">(row.tenantId),
      legalName: row.legalName,
      officialIdentifiers: row.officialIdentifiers as Organisation["officialIdentifiers"],
      memberState: row.memberState,
      isPublicSectorBody: row.isPublicSectorBody,
      createdAt: row.createdAt,
    };
  }

  // --- relying parties -----------------------------------------------------

  async createRelyingParty(rp: RelyingParty): Promise<RelyingParty> {
    await this.db.insert(relyingParties).values({
      id: rp.id,
      tenantId: rp.tenantId,
      organisationId: rp.organisationId,
      registrarAssignedIdentifier: rp.registrarAssignedIdentifier,
      registrar: rp.registrar,
      registryUri: rp.registryUri ?? null,
      tradeName: rp.tradeName ?? null,
      trustEnvironment: rp.trustEnvironment,
      createdAt: rp.createdAt,
    });
    return rp;
  }

  async findRelyingParty(
    tenantId: TenantId,
    id: RelyingPartyId,
  ): Promise<RelyingParty | undefined> {
    const [row] = await this.db
      .select()
      .from(relyingParties)
      .where(and(eq(relyingParties.tenantId, tenantId), eq(relyingParties.id, id)))
      .limit(1);
    return row ? mapRelyingParty(row) : undefined;
  }

  // --- services ------------------------------------------------------------

  async createRelyingPartyService(
    service: RelyingPartyService,
    webhookSecret: string,
    webhookEndpointId?: WebhookEndpointId,
  ): Promise<RelyingPartyService> {
    await this.db.insert(relyingPartyServices).values({
      id: service.id,
      tenantId: service.tenantId,
      relyingPartyId: service.relyingPartyId,
      serviceIdentifier: service.serviceIdentifier,
      serviceTradeName: service.serviceTradeName,
      description: service.description,
      callbackUrlAllowList: service.callbackUrlAllowList,
      webhookSecret,
      webhookEndpointId: webhookEndpointId ?? null,
      createdAt: service.createdAt,
    });
    return service;
  }

  async findRelyingPartyService(
    tenantId: TenantId,
    id: RelyingPartyServiceId,
  ): Promise<RelyingPartyService | undefined> {
    const [row] = await this.db
      .select()
      .from(relyingPartyServices)
      .where(and(eq(relyingPartyServices.tenantId, tenantId), eq(relyingPartyServices.id, id)))
      .limit(1);
    return row ? mapService(row) : undefined;
  }

  /** The HMAC secret used to sign outbound callbacks for this service. */
  /** The Relying Party Service's callback destination. The route a presentation takes to a secret. */
  async findWebhookEndpointId(
    tenantId: TenantId,
    id: RelyingPartyServiceId,
  ): Promise<WebhookEndpointId | undefined> {
    const [row] = await this.db
      .select({ endpointId: relyingPartyServices.webhookEndpointId })
      .from(relyingPartyServices)
      .where(and(eq(relyingPartyServices.tenantId, tenantId), eq(relyingPartyServices.id, id)))
      .limit(1);
    return row?.endpointId ? asId<"WebhookEndpointId">(row.endpointId) : undefined;
  }

  /** Superseded by `findWebhookEndpointId`. Retained while migration 0002's columns remain. */
  async findWebhookSecret(
    tenantId: TenantId,
    id: RelyingPartyServiceId,
  ): Promise<string | undefined> {
    const [row] = await this.db
      .select({ secret: relyingPartyServices.webhookSecret })
      .from(relyingPartyServices)
      .where(and(eq(relyingPartyServices.tenantId, tenantId), eq(relyingPartyServices.id, id)))
      .limit(1);
    return row?.secret ?? undefined;
  }

  // --- intended uses -------------------------------------------------------

  async createIntendedUse(use: IntendedUse): Promise<IntendedUse> {
    await this.db.insert(intendedUses).values({
      id: use.id,
      tenantId: use.tenantId,
      relyingPartyServiceId: use.relyingPartyServiceId,
      intendedUseIdentifier: use.intendedUseIdentifier,
      purpose: use.purpose,
      privacyPolicyUris: use.privacyPolicyUris,
      registeredCredentials: use.registeredCredentials,
      validFrom: use.validFrom,
      revokedAt: use.revokedAt ?? null,
      createdAt: use.createdAt,
    });
    return use;
  }

  async findIntendedUse(
    tenantId: TenantId,
    id: IntendedUseId,
  ): Promise<IntendedUse | undefined> {
    const [row] = await this.db
      .select()
      .from(intendedUses)
      .where(and(eq(intendedUses.tenantId, tenantId), eq(intendedUses.id, id)))
      .limit(1);
    return row ? mapIntendedUse(row) : undefined;
  }

  // --- certificates and instances ------------------------------------------

  async createRegistrationCertificate(
    cert: RegistrationCertificate,
  ): Promise<RegistrationCertificate> {
    await this.db.insert(registrationCertificates).values({
      id: cert.id,
      tenantId: cert.tenantId,
      relyingPartyServiceId: cert.relyingPartyServiceId,
      intendedUseId: cert.intendedUseId,
      jwt: cert.jwt ?? null,
      provider: cert.provider ?? null,
      notBefore: cert.notBefore ?? null,
      notAfter: cert.notAfter ?? null,
      trustEnvironment: cert.trustEnvironment,
      createdAt: cert.createdAt,
    });
    return cert;
  }

  async findRegistrationCertificateForIntendedUse(
    tenantId: TenantId,
    intendedUseId: IntendedUseId,
  ): Promise<RegistrationCertificate | undefined> {
    const [row] = await this.db
      .select()
      .from(registrationCertificates)
      .where(
        and(
          eq(registrationCertificates.tenantId, tenantId),
          eq(registrationCertificates.intendedUseId, intendedUseId),
        ),
      )
      .limit(1);
    if (!row) return undefined;
    return {
      id: asId<"RegistrationCertificateId">(row.id),
      tenantId: asId<"TenantId">(row.tenantId),
      relyingPartyServiceId: asId<"RelyingPartyServiceId">(row.relyingPartyServiceId),
      intendedUseId: asId<"IntendedUseId">(row.intendedUseId),
      ...(row.jwt ? { jwt: row.jwt } : {}),
      ...(row.provider ? { provider: row.provider } : {}),
      ...(row.notBefore ? { notBefore: row.notBefore } : {}),
      ...(row.notAfter ? { notAfter: row.notAfter } : {}),
      trustEnvironment: row.trustEnvironment as TrustEnvironment,
      createdAt: row.createdAt,
    };
  }

  async createAccessCertificate(cert: AccessCertificate): Promise<AccessCertificate> {
    await this.db.insert(accessCertificates).values({
      id: cert.id,
      tenantId: cert.tenantId,
      relyingPartyId: cert.relyingPartyId,
      relyingPartyServiceId: cert.relyingPartyServiceId,
      keyBindingRef: cert.keyBindingRef,
      subject: cert.subject ?? null,
      issuer: cert.issuer ?? null,
      notBefore: cert.notBefore ?? null,
      notAfter: cert.notAfter ?? null,
      trustEnvironment: cert.trustEnvironment,
      createdAt: cert.createdAt,
    });
    return cert;
  }

  async findAccessCertificateForService(
    tenantId: TenantId,
    serviceId: RelyingPartyServiceId,
  ): Promise<AccessCertificate | undefined> {
    const [row] = await this.db
      .select()
      .from(accessCertificates)
      .where(
        and(
          eq(accessCertificates.tenantId, tenantId),
          eq(accessCertificates.relyingPartyServiceId, serviceId),
        ),
      )
      .limit(1);
    if (!row) return undefined;
    return {
      id: asId<"AccessCertificateId">(row.id),
      tenantId: asId<"TenantId">(row.tenantId),
      relyingPartyId: asId<"RelyingPartyId">(row.relyingPartyId),
      relyingPartyServiceId: asId<"RelyingPartyServiceId">(row.relyingPartyServiceId),
      keyBindingRef: row.keyBindingRef,
      ...(row.subject ? { subject: row.subject } : {}),
      ...(row.issuer ? { issuer: row.issuer } : {}),
      ...(row.notBefore ? { notBefore: row.notBefore } : {}),
      ...(row.notAfter ? { notAfter: row.notAfter } : {}),
      trustEnvironment: row.trustEnvironment as TrustEnvironment,
      createdAt: row.createdAt,
    };
  }

  async createRelyingPartyInstance(
    instance: RelyingPartyInstance,
  ): Promise<RelyingPartyInstance> {
    await this.db.insert(relyingPartyInstances).values({
      id: instance.id,
      tenantId: instance.tenantId,
      relyingPartyServiceId: instance.relyingPartyServiceId,
      engineTenantRef: instance.engineTenantRef,
      trustEnvironment: instance.trustEnvironment,
      createdAt: instance.createdAt,
    });
    return instance;
  }

  async findInstanceForService(
    tenantId: TenantId,
    serviceId: RelyingPartyServiceId,
  ): Promise<RelyingPartyInstance | undefined> {
    const [row] = await this.db
      .select()
      .from(relyingPartyInstances)
      .where(
        and(
          eq(relyingPartyInstances.tenantId, tenantId),
          eq(relyingPartyInstances.relyingPartyServiceId, serviceId),
        ),
      )
      .limit(1);
    if (!row) return undefined;
    return {
      id: asId<"RelyingPartyInstanceId">(row.id),
      tenantId: asId<"TenantId">(row.tenantId),
      relyingPartyServiceId: asId<"RelyingPartyServiceId">(row.relyingPartyServiceId),
      engineTenantRef: row.engineTenantRef,
      trustEnvironment: row.trustEnvironment as TrustEnvironment,
      createdAt: row.createdAt,
    };
  }

  /**
   * Loads everything the compiler needs for one policy, in one place.
   *
   * A missing piece is a 409 rather than a 500: an operator who has not yet imported an
   * access certificate or provisioned an instance needs to be told which step is
   * outstanding, not handed an internal error.
   */
  async loadCompilerContext(
    tenantId: TenantId,
    serviceId: RelyingPartyServiceId,
    intendedUseId: IntendedUseId,
  ): Promise<{
    readonly relyingParty: RelyingParty;
    readonly service: RelyingPartyService;
    readonly instance: RelyingPartyInstance;
    readonly intendedUse: IntendedUse;
    readonly accessCertificate: AccessCertificate;
    readonly registrationCertificate?: RegistrationCertificate;
  }> {
    const service = await this.findRelyingPartyService(tenantId, serviceId);
    if (!service) throw PlatformError.notFound("Relying Party Service");

    const relyingParty = await this.findRelyingParty(tenantId, service.relyingPartyId);
    if (!relyingParty) throw PlatformError.notFound("Relying Party");

    const intendedUse = await this.findIntendedUse(tenantId, intendedUseId);
    if (!intendedUse) throw PlatformError.notFound("Intended use");
    if (intendedUse.relyingPartyServiceId !== serviceId) {
      throw PlatformError.conflict(
        "intended_use_service_mismatch",
        "The intended use does not belong to the Relying Party Service of this policy.",
      );
    }

    const instance = await this.findInstanceForService(tenantId, serviceId);
    if (!instance) {
      throw PlatformError.conflict(
        "no_relying_party_instance",
        "No Relying Party Instance is provisioned for this Service. Provision one before " +
          "creating a presentation.",
      );
    }

    const accessCertificate = await this.findAccessCertificateForService(tenantId, serviceId);
    if (!accessCertificate) {
      throw PlatformError.conflict(
        "no_access_certificate",
        "No access certificate is bound to this Relying Party Service. Relying Party " +
          "authentication is required in every presentation transaction, so a presentation " +
          "cannot be created without one.",
      );
    }

    const registrationCertificate = await this.findRegistrationCertificateForIntendedUse(
      tenantId,
      intendedUseId,
    );

    return {
      relyingParty,
      service,
      instance,
      intendedUse,
      accessCertificate,
      ...(registrationCertificate ? { registrationCertificate } : {}),
    };
  }
}

type RelyingPartyRow = typeof relyingParties.$inferSelect;
type ServiceRow = typeof relyingPartyServices.$inferSelect;
type IntendedUseRow = typeof intendedUses.$inferSelect;

const mapRelyingParty = (row: RelyingPartyRow): RelyingParty => ({
  id: asId<"RelyingPartyId">(row.id),
  tenantId: asId<"TenantId">(row.tenantId),
  organisationId: asId<"OrganisationId">(row.organisationId),
  registrarAssignedIdentifier: row.registrarAssignedIdentifier,
  registrar: row.registrar,
  ...(row.registryUri ? { registryUri: row.registryUri } : {}),
  ...(row.tradeName ? { tradeName: row.tradeName } : {}),
  trustEnvironment: row.trustEnvironment as TrustEnvironment,
  createdAt: row.createdAt,
});

const mapService = (row: ServiceRow): RelyingPartyService => ({
  id: asId<"RelyingPartyServiceId">(row.id),
  tenantId: asId<"TenantId">(row.tenantId),
  relyingPartyId: asId<"RelyingPartyId">(row.relyingPartyId),
  serviceIdentifier: row.serviceIdentifier,
  serviceTradeName: row.serviceTradeName,
  description: row.description as RelyingPartyService["description"],
  callbackUrlAllowList: row.callbackUrlAllowList as readonly string[],
  createdAt: row.createdAt,
});

const mapIntendedUse = (row: IntendedUseRow): IntendedUse => ({
  id: asId<"IntendedUseId">(row.id),
  tenantId: asId<"TenantId">(row.tenantId),
  relyingPartyServiceId: asId<"RelyingPartyServiceId">(row.relyingPartyServiceId),
  intendedUseIdentifier: row.intendedUseIdentifier,
  purpose: row.purpose as IntendedUse["purpose"],
  privacyPolicyUris: row.privacyPolicyUris as IntendedUse["privacyPolicyUris"],
  registeredCredentials: row.registeredCredentials as IntendedUse["registeredCredentials"],
  validFrom: row.validFrom,
  ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
  createdAt: row.createdAt,
});
