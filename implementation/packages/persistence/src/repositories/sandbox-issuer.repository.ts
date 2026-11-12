import { asId, type TenantId } from "@edtp/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "../db.js";
import { sandboxIssuances, sandboxIssuers } from "../schema.js";

/** The sandbox's hosted PID issuers and their issuances (S5). Every read names the tenant. */
export interface SandboxIssuerRecord {
  readonly relyingPartyServiceId: string;
  readonly tenantId: TenantId;
  readonly engineTenantRef: string;
  readonly attestationProviderId: string;
  readonly credentialTypeId: string;
  readonly issuancePolicyId: string;
  readonly signingCertificateId: string;
  readonly registrationCertificateId: string;
  readonly configuredAt: Date;
}

export interface SandboxIssuanceRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly relyingPartyServiceId: string;
  readonly issuanceId: string;
  readonly signingCertificateId: string;
  readonly registrationCertificateId: string;
  readonly createdAt: Date;
  readonly revokedAt?: Date;
}

const toIssuer = (r: typeof sandboxIssuers.$inferSelect): SandboxIssuerRecord => ({
  relyingPartyServiceId: r.relyingPartyServiceId,
  tenantId: asId<"TenantId">(r.tenantId),
  engineTenantRef: r.engineTenantRef,
  attestationProviderId: r.attestationProviderId,
  credentialTypeId: r.credentialTypeId,
  issuancePolicyId: r.issuancePolicyId,
  signingCertificateId: r.signingCertificateId,
  registrationCertificateId: r.registrationCertificateId,
  configuredAt: r.configuredAt,
});

const toIssuance = (r: typeof sandboxIssuances.$inferSelect): SandboxIssuanceRecord => ({
  id: r.id,
  tenantId: asId<"TenantId">(r.tenantId),
  relyingPartyServiceId: r.relyingPartyServiceId,
  issuanceId: r.issuanceId,
  signingCertificateId: r.signingCertificateId,
  registrationCertificateId: r.registrationCertificateId,
  createdAt: r.createdAt,
  ...(r.revokedAt ? { revokedAt: r.revokedAt } : {}),
});

export class SandboxIssuerRepository {
  constructor(private readonly db: Database) {}

  async issuer(
    tenantId: TenantId,
    serviceId: string,
  ): Promise<SandboxIssuerRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(sandboxIssuers)
      .where(
        and(
          eq(sandboxIssuers.tenantId, tenantId),
          eq(sandboxIssuers.relyingPartyServiceId, serviceId),
        ),
      );
    return row ? toIssuer(row) : undefined;
  }

  async createIssuer(
    record: SandboxIssuerRecord & { readonly createdAt: Date },
  ): Promise<void> {
    await this.db.insert(sandboxIssuers).values(record);
  }

  async setCertificates(
    tenantId: TenantId,
    serviceId: string,
    input: { signingCertificateId: string; registrationCertificateId: string; at: Date },
  ): Promise<void> {
    await this.db
      .update(sandboxIssuers)
      .set({
        signingCertificateId: input.signingCertificateId,
        registrationCertificateId: input.registrationCertificateId,
        configuredAt: input.at,
      })
      .where(
        and(
          eq(sandboxIssuers.tenantId, tenantId),
          eq(sandboxIssuers.relyingPartyServiceId, serviceId),
        ),
      );
  }

  async createIssuance(record: SandboxIssuanceRecord): Promise<void> {
    await this.db.insert(sandboxIssuances).values({
      id: record.id,
      tenantId: record.tenantId,
      relyingPartyServiceId: record.relyingPartyServiceId,
      issuanceId: record.issuanceId,
      signingCertificateId: record.signingCertificateId,
      registrationCertificateId: record.registrationCertificateId,
      createdAt: record.createdAt,
    });
  }

  async issuance(tenantId: TenantId, id: string): Promise<SandboxIssuanceRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(sandboxIssuances)
      .where(and(eq(sandboxIssuances.tenantId, tenantId), eq(sandboxIssuances.id, id)));
    return row ? toIssuance(row) : undefined;
  }

  async issuances(tenantId: TenantId, serviceId: string): Promise<SandboxIssuanceRecord[]> {
    const rows = await this.db
      .select()
      .from(sandboxIssuances)
      .where(
        and(
          eq(sandboxIssuances.tenantId, tenantId),
          eq(sandboxIssuances.relyingPartyServiceId, serviceId),
        ),
      )
      .orderBy(desc(sandboxIssuances.createdAt))
      .limit(200);
    return rows.map(toIssuance);
  }

  /** Once: a revoked PID is never reinstated (`AS-AP-07-007`, `VCR_04`). */
  async markRevoked(tenantId: TenantId, id: string, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(sandboxIssuances)
      .set({ revokedAt: at })
      .where(
        and(
          eq(sandboxIssuances.tenantId, tenantId),
          eq(sandboxIssuances.id, id),
          isNull(sandboxIssuances.revokedAt),
        ),
      )
      .returning({ id: sandboxIssuances.id });
    return rows.length === 1;
  }
}
