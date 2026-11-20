import { asId, type TenantId } from "@edtp/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db.js";
import { sandboxCredentialTypes, sandboxServices } from "../schema.js";

/**
 * Credential types of the sandbox's EAA Providers (ADR 0023 §2). A version is never updated except to
 * record the platform type and policy it became on the hosted issuer. Every read of a participant's
 * types names the tenant; the public reads (the register, Type Metadata) are by vct.
 */
export interface SandboxCredentialTypeRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly relyingPartyServiceId: string;
  readonly slug: string;
  readonly version: number;
  readonly vct: string;
  readonly definition: unknown;
  readonly credentialTypeId?: string;
  readonly issuancePolicyId?: string;
  readonly createdAt: Date;
}

const toRecord = (
  r: typeof sandboxCredentialTypes.$inferSelect,
): SandboxCredentialTypeRecord => ({
  id: r.id,
  tenantId: asId<"TenantId">(r.tenantId),
  relyingPartyServiceId: r.relyingPartyServiceId,
  slug: r.slug,
  version: r.version,
  vct: r.vct,
  definition: r.definition,
  ...(r.credentialTypeId ? { credentialTypeId: r.credentialTypeId } : {}),
  ...(r.issuancePolicyId ? { issuancePolicyId: r.issuancePolicyId } : {}),
  createdAt: r.createdAt,
});

export class SandboxCredentialTypeRepository {
  constructor(private readonly db: Database) {}

  async create(record: SandboxCredentialTypeRecord): Promise<void> {
    await this.db.insert(sandboxCredentialTypes).values({
      id: record.id,
      tenantId: record.tenantId,
      relyingPartyServiceId: record.relyingPartyServiceId,
      slug: record.slug,
      version: record.version,
      vct: record.vct,
      definition: record.definition,
      createdAt: record.createdAt,
    });
  }

  /** Every version of every type of a service, newest version first within a type. */
  async ofService(
    tenantId: TenantId,
    serviceId: string,
  ): Promise<SandboxCredentialTypeRecord[]> {
    const rows = await this.db
      .select()
      .from(sandboxCredentialTypes)
      .where(
        and(
          eq(sandboxCredentialTypes.tenantId, tenantId),
          eq(sandboxCredentialTypes.relyingPartyServiceId, serviceId),
        ),
      )
      .orderBy(asc(sandboxCredentialTypes.slug), desc(sandboxCredentialTypes.version));
    return rows.map(toRecord);
  }

  async byId(tenantId: TenantId, id: string): Promise<SandboxCredentialTypeRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(sandboxCredentialTypes)
      .where(
        and(eq(sandboxCredentialTypes.tenantId, tenantId), eq(sandboxCredentialTypes.id, id)),
      );
    return row ? toRecord(row) : undefined;
  }

  /** The latest version under a vct, for its Type Metadata. Public: a vct is a public name. */
  async latestByVct(vct: string): Promise<SandboxCredentialTypeRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(sandboxCredentialTypes)
      .where(eq(sandboxCredentialTypes.vct, vct))
      .orderBy(desc(sandboxCredentialTypes.version))
      .limit(1);
    return row ? toRecord(row) : undefined;
  }

  /** The latest version of every type in the sandbox, for the register and Relying Parties' uses. */
  async latestAll(): Promise<SandboxCredentialTypeRecord[]> {
    const rows = await this.db
      .selectDistinctOn([sandboxCredentialTypes.vct])
      .from(sandboxCredentialTypes)
      .innerJoin(
        sandboxServices,
        eq(sandboxServices.relyingPartyServiceId, sandboxCredentialTypes.relyingPartyServiceId),
      )
      .orderBy(asc(sandboxCredentialTypes.vct), desc(sandboxCredentialTypes.version));
    return rows.map((r) => toRecord(r.sandbox_credential_types));
  }

  async countTypes(tenantId: TenantId, serviceId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(distinct ${sandboxCredentialTypes.slug})::int` })
      .from(sandboxCredentialTypes)
      .where(
        and(
          eq(sandboxCredentialTypes.tenantId, tenantId),
          eq(sandboxCredentialTypes.relyingPartyServiceId, serviceId),
        ),
      );
    return row?.n ?? 0;
  }

  async latestVersion(tenantId: TenantId, serviceId: string, slug: string): Promise<number> {
    const [row] = await this.db
      .select({ v: sql<number>`coalesce(max(${sandboxCredentialTypes.version}), 0)::int` })
      .from(sandboxCredentialTypes)
      .where(
        and(
          eq(sandboxCredentialTypes.tenantId, tenantId),
          eq(sandboxCredentialTypes.relyingPartyServiceId, serviceId),
          eq(sandboxCredentialTypes.slug, slug),
        ),
      );
    return row?.v ?? 0;
  }

  /** Record what a version became on the hosted issuer. Once per version. */
  async setProvisioned(
    tenantId: TenantId,
    id: string,
    ids: { credentialTypeId: string; issuancePolicyId: string },
  ): Promise<void> {
    await this.db
      .update(sandboxCredentialTypes)
      .set(ids)
      .where(
        and(eq(sandboxCredentialTypes.tenantId, tenantId), eq(sandboxCredentialTypes.id, id)),
      );
  }
}
