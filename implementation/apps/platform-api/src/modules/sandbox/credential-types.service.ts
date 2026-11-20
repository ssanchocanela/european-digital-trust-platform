import type {
  SandboxCertificateRepository,
  SandboxCredentialTypeRecord,
  SandboxCredentialTypeRepository,
  SandboxRepository,
} from "@edtp/persistence";
import {
  type SandboxCredentialTypeDefinition,
  sandboxVct,
  typeMetadata,
  validateSandboxCredentialType,
} from "@edtp/sandbox-domain";
import { type Clock, newUuid, PlatformError } from "@edtp/shared";
import type { AuditService } from "../audit/audit.service.js";
import type { SandboxIssuerService } from "./issuer.service.js";
import { assertQuota } from "./quotas.js";
import type { SandboxService, SignedInContext } from "./sandbox.service.js";
import type { SandboxUrls } from "./urls.js";

/**
 * Credential types of EAA Provider services (ADR 0023 §2): defined by the participant, versioned,
 * never edited. The sandbox assigns each type's vct under its own public address and serves its Type
 * Metadata there. A new version is made issuable on the service's hosted issuer at once, if it has one.
 */
export class SandboxCredentialTypeService {
  constructor(
    private readonly sandbox: SandboxService,
    private readonly people: SandboxRepository,
    private readonly services: SandboxCertificateRepository,
    private readonly types: SandboxCredentialTypeRepository,
    private readonly issuer: SandboxIssuerService | undefined,
    private readonly urls: SandboxUrls,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private async providerOf(context: SignedInContext, orgId: string, serviceId: string) {
    const membership = await this.sandbox.activeMembershipIn(context, orgId);
    const service = await this.services.service(membership.tenantId, serviceId);
    if (!service) throw PlatformError.notFound("Service");
    if (service.role !== "eaa_provider") {
      throw PlatformError.conflict(
        "sandbox_not_an_eaa_provider",
        "Only an EAA Provider service defines credential types.",
      );
    }
    const organisation = await this.people.findOrganisation(membership.tenantId);
    if (!organisation) throw PlatformError.notFound("Organisation");
    return { tenantId: membership.tenantId, organisation };
  }

  private static describe(r: SandboxCredentialTypeRecord) {
    return {
      id: r.id,
      slug: r.slug,
      version: r.version,
      vct: r.vct,
      definition: r.definition as SandboxCredentialTypeDefinition,
      issuable: Boolean(r.issuancePolicyId),
      createdAt: r.createdAt,
    };
  }

  /** A service's types, each with its versions, newest first. */
  async list(context: SignedInContext, orgId: string, serviceId: string) {
    const { tenantId } = await this.providerOf(context, orgId, serviceId);
    const records = await this.types.ofService(tenantId, serviceId);
    const bySlug = new Map<
      string,
      ReturnType<typeof SandboxCredentialTypeService.describe>[]
    >();
    for (const r of records) {
      bySlug.set(r.slug, [
        ...(bySlug.get(r.slug) ?? []),
        SandboxCredentialTypeService.describe(r),
      ]);
    }
    return [...bySlug.entries()].map(([slug, versions]) => ({
      slug,
      vct: versions[0]?.vct,
      versions,
    }));
  }

  /**
   * A new version of a type — the first, for a new name. Immutable from here on: a change is the next
   * version. Every version keeps the type's vct.
   */
  async create(
    context: SignedInContext,
    orgId: string,
    serviceId: string,
    input: { readonly slug: string; readonly definition: SandboxCredentialTypeDefinition },
  ) {
    const { tenantId, organisation } = await this.providerOf(context, orgId, serviceId);
    validateSandboxCredentialType(input.slug, input.definition);
    const latest = await this.types.latestVersion(tenantId, serviceId, input.slug);
    if (latest === 0) {
      assertQuota(
        "credentialTypesPerService",
        await this.types.countTypes(tenantId, serviceId),
      );
    } else {
      assertQuota("versionsPerCredentialType", latest);
    }
    const record: SandboxCredentialTypeRecord = {
      id: newUuid(),
      tenantId,
      relyingPartyServiceId: serviceId,
      slug: input.slug,
      version: latest + 1,
      vct: sandboxVct(this.urls.base, organisation.localIdentifier, input.slug),
      definition: input.definition,
      createdAt: this.clock.now(),
    };
    await this.types.create(record);
    await this.audit.record({
      tenantId,
      actor: "sandbox",
      action: "sandbox.credential_type.created",
      subjectType: "sandbox_credential_type",
      subjectId: record.id,
      detail: { version: record.version, claims: input.definition.claims.length },
    });
    await this.issuer?.provisionType(tenantId, serviceId, record);
    const stored = await this.types.byId(tenantId, record.id);
    return SandboxCredentialTypeService.describe(stored ?? record);
  }

  /**
   * Every type in the sandbox, latest version, for a Relying Party choosing what to request. Names and
   * claim names only: what the register publishes anyway.
   */
  async registered(context: SignedInContext) {
    void context;
    return (await this.types.latestAll()).map((r) => {
      const d = r.definition as SandboxCredentialTypeDefinition;
      return {
        vct: r.vct,
        version: r.version,
        display: d.display,
        claims: d.claims.map((c) => ({ name: c.name, display: c.display })),
      };
    });
  }

  /** Type Metadata at a vct: public, as a vct is a public name. */
  async metadata(organisationSegment: string, slug: string) {
    const vct = `${this.urls.base}/vct/${organisationSegment}/${slug}`;
    const record = await this.types.latestByVct(vct);
    if (!record) throw PlatformError.notFound("Credential type");
    return typeMetadata(
      record.vct,
      record.version,
      record.definition as SandboxCredentialTypeDefinition,
    );
  }
}
