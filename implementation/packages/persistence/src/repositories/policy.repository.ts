import type {
  PolicyContainerStatus,
  PolicyStatus,
  PresentationPolicy,
  PresentationPolicyVersion,
} from "@edtp/domain";
import type { PresentationPolicyId, TenantId } from "@edtp/shared";
import { asId, PlatformError } from "@edtp/shared";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../db.js";
import { presentationPolicies, presentationPolicyVersions } from "../schema.js";

/**
 * Policy and policy-version repository.
 *
 * Immutability of a published version is enforced here, not only in the domain: there is
 * no method that updates the body of a version, and `publish` and `retire` write only
 * status and timestamp columns. A caller cannot edit a published version even by
 * mistake, because no code path exists to do it.
 */
export class PolicyRepository {
  constructor(private readonly db: Database) {}

  async createPolicy(policy: PresentationPolicy): Promise<PresentationPolicy> {
    await this.db.insert(presentationPolicies).values({
      id: policy.id,
      tenantId: policy.tenantId,
      relyingPartyServiceId: policy.relyingPartyServiceId,
      intendedUseId: policy.intendedUseId,
      name: policy.name,
      description: policy.description,
      status: policy.status,
      createdAt: policy.createdAt,
    });
    return policy;
  }

  async findPolicy(
    tenantId: TenantId,
    id: PresentationPolicyId,
  ): Promise<PresentationPolicy | undefined> {
    const [row] = await this.db
      .select()
      .from(presentationPolicies)
      .where(and(eq(presentationPolicies.tenantId, tenantId), eq(presentationPolicies.id, id)))
      .limit(1);
    if (!row) return undefined;
    return {
      id: asId<"PresentationPolicyId">(row.id),
      tenantId: asId<"TenantId">(row.tenantId),
      relyingPartyServiceId: asId<"RelyingPartyServiceId">(row.relyingPartyServiceId),
      intendedUseId: asId<"IntendedUseId">(row.intendedUseId),
      name: row.name,
      description: row.description,
      status: row.status as PolicyContainerStatus,
      createdAt: row.createdAt,
    };
  }

  async listVersions(
    tenantId: TenantId,
    policyId: PresentationPolicyId,
  ): Promise<readonly PresentationPolicyVersion[]> {
    const rows = await this.db
      .select()
      .from(presentationPolicyVersions)
      .where(
        and(
          eq(presentationPolicyVersions.tenantId, tenantId),
          eq(presentationPolicyVersions.policyId, policyId),
        ),
      )
      .orderBy(asc(presentationPolicyVersions.version));
    return rows.map(mapVersion);
  }

  async findVersion(
    tenantId: TenantId,
    policyId: PresentationPolicyId,
    version: number,
  ): Promise<PresentationPolicyVersion | undefined> {
    const [row] = await this.db
      .select()
      .from(presentationPolicyVersions)
      .where(
        and(
          eq(presentationPolicyVersions.tenantId, tenantId),
          eq(presentationPolicyVersions.policyId, policyId),
          eq(presentationPolicyVersions.version, version),
        ),
      )
      .limit(1);
    return row ? mapVersion(row) : undefined;
  }

  async createVersion(version: PresentationPolicyVersion): Promise<PresentationPolicyVersion> {
    await this.db.insert(presentationPolicyVersions).values({
      id: version.id,
      tenantId: version.tenantId,
      policyId: version.policyId,
      version: version.version,
      purpose: version.purpose,
      credentialRequirements: version.credentialRequirements,
      requestedClaims: version.requestedClaims,
      trustPolicy: version.trustPolicy,
      resultPolicy: version.resultPolicy,
      retentionPolicy: version.retentionPolicy,
      status: version.status,
      createdAt: version.createdAt,
      publishedAt: version.publishedAt ?? null,
      retiredAt: version.retiredAt ?? null,
    });
    return version;
  }

  /**
   * Marks a draft version published.
   *
   * The `status = 'DRAFT'` predicate makes this a compare-and-set: a concurrent publish
   * of the same version affects zero rows the second time, and the caller sees a
   * conflict instead of both callers believing they published it.
   */
  async publishVersion(
    tenantId: TenantId,
    policyId: PresentationPolicyId,
    version: number,
    at: Date,
  ): Promise<void> {
    const updated = await this.db
      .update(presentationPolicyVersions)
      .set({ status: "PUBLISHED", publishedAt: at })
      .where(
        and(
          eq(presentationPolicyVersions.tenantId, tenantId),
          eq(presentationPolicyVersions.policyId, policyId),
          eq(presentationPolicyVersions.version, version),
          eq(presentationPolicyVersions.status, "DRAFT"),
        ),
      )
      .returning({ id: presentationPolicyVersions.id });
    if (updated.length === 0) {
      throw PlatformError.conflict(
        "policy_version_not_draft",
        "Only a draft policy version can be published.",
      );
    }
  }

  async retireVersion(
    tenantId: TenantId,
    policyId: PresentationPolicyId,
    version: number,
    at: Date,
  ): Promise<void> {
    await this.db
      .update(presentationPolicyVersions)
      .set({ status: "RETIRED", retiredAt: at })
      .where(
        and(
          eq(presentationPolicyVersions.tenantId, tenantId),
          eq(presentationPolicyVersions.policyId, policyId),
          eq(presentationPolicyVersions.version, version),
        ),
      );
  }
}

type VersionRow = typeof presentationPolicyVersions.$inferSelect;

const mapVersion = (row: VersionRow): PresentationPolicyVersion => ({
  id: asId<"PresentationPolicyVersionId">(row.id),
  tenantId: asId<"TenantId">(row.tenantId),
  policyId: asId<"PresentationPolicyId">(row.policyId),
  version: row.version,
  purpose: row.purpose as PresentationPolicyVersion["purpose"],
  credentialRequirements:
    row.credentialRequirements as PresentationPolicyVersion["credentialRequirements"],
  requestedClaims: row.requestedClaims as PresentationPolicyVersion["requestedClaims"],
  trustPolicy: row.trustPolicy as PresentationPolicyVersion["trustPolicy"],
  resultPolicy: row.resultPolicy as PresentationPolicyVersion["resultPolicy"],
  retentionPolicy: row.retentionPolicy as PresentationPolicyVersion["retentionPolicy"],
  status: row.status as PolicyStatus,
  createdAt: row.createdAt,
  ...(row.publishedAt ? { publishedAt: row.publishedAt } : {}),
  ...(row.retiredAt ? { retiredAt: row.retiredAt } : {}),
});
