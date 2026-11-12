import { asId, type TenantId } from "@edtp/shared";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../db.js";
import {
  intendedUses,
  organisations,
  relyingParties,
  relyingPartyServices,
  sandboxCertificates,
  sandboxOrganisations,
  sandboxPublications,
  sandboxServices,
} from "../schema.js";

/**
 * The sandbox's certificate service (S3, ADR 0014): services, issued certificates and publications.
 * Every read of an organisation's data names its tenant; the public reads (revocations, the register)
 * read only what is public by nature.
 */
export type SandboxServiceRole = "service_provider" | "pid_provider";

export interface SandboxServiceRecord {
  readonly relyingPartyServiceId: string;
  readonly tenantId: TenantId;
  readonly serviceIdentifier: string;
  readonly serviceTradeName: string;
  readonly description: readonly { lang: string; value: string }[];
  readonly role: SandboxServiceRole;
  readonly supportUri: string;
  readonly privacyPolicyUri: string;
  readonly infoUri: string;
  readonly createdAt: Date;
}

export interface SandboxCertificateRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly relyingPartyServiceId: string;
  readonly intendedUseId?: string;
  readonly kind: "WRPAC" | "WRPRC";
  readonly variant: string;
  readonly issuerKey: string;
  readonly serialHex?: string;
  readonly statusIndex?: number;
  readonly notBefore?: Date;
  readonly notAfter?: Date;
  readonly body?: string;
  readonly fingerprintSha256?: string;
  readonly dnsNames: readonly string[];
  readonly createdAt: Date;
  readonly revokedAt?: Date;
  /** `takeaway`: issued against the participant's request. `hosted`: its key went to the engine. */
  readonly mode: "takeaway" | "hosted";
}

export interface Publication {
  readonly channel: string;
  readonly sequence: number;
  readonly issuedAt: Date;
  readonly nextUpdate: Date;
  readonly body: string;
  readonly contentHash: string;
}

const toCertificate = (
  r: typeof sandboxCertificates.$inferSelect,
): SandboxCertificateRecord => ({
  id: r.id,
  tenantId: asId<"TenantId">(r.tenantId),
  relyingPartyServiceId: r.relyingPartyServiceId,
  ...(r.intendedUseId ? { intendedUseId: r.intendedUseId } : {}),
  kind: r.kind as SandboxCertificateRecord["kind"],
  variant: r.variant,
  issuerKey: r.issuerKey,
  ...(r.serialHex ? { serialHex: r.serialHex } : {}),
  ...(r.statusIndex !== null ? { statusIndex: r.statusIndex } : {}),
  ...(r.notBefore ? { notBefore: r.notBefore } : {}),
  ...(r.notAfter ? { notAfter: r.notAfter } : {}),
  ...(r.body ? { body: r.body } : {}),
  ...(r.fingerprintSha256 ? { fingerprintSha256: r.fingerprintSha256 } : {}),
  dnsNames: r.dnsNames as string[],
  createdAt: r.createdAt,
  ...(r.revokedAt ? { revokedAt: r.revokedAt } : {}),
  mode: r.mode as SandboxCertificateRecord["mode"],
});

export class SandboxCertificateRepository {
  constructor(private readonly db: Database) {}

  // --- services --------------------------------------------------------------------------------

  async createServiceRecord(input: {
    readonly relyingPartyServiceId: string;
    readonly tenantId: TenantId;
    readonly role: SandboxServiceRole;
    readonly supportUri: string;
    readonly privacyPolicyUri: string;
    readonly infoUri: string;
    readonly createdAt: Date;
  }): Promise<void> {
    await this.db.insert(sandboxServices).values(input);
  }

  private servicesQuery() {
    return this.db
      .select({ s: sandboxServices, rps: relyingPartyServices })
      .from(sandboxServices)
      .innerJoin(
        relyingPartyServices,
        eq(relyingPartyServices.id, sandboxServices.relyingPartyServiceId),
      );
  }

  private toService(row: {
    s: typeof sandboxServices.$inferSelect;
    rps: typeof relyingPartyServices.$inferSelect;
  }): SandboxServiceRecord {
    return {
      relyingPartyServiceId: row.s.relyingPartyServiceId,
      tenantId: asId<"TenantId">(row.s.tenantId),
      serviceIdentifier: row.rps.serviceIdentifier,
      serviceTradeName: row.rps.serviceTradeName,
      description: row.rps.description as { lang: string; value: string }[],
      role: row.s.role as SandboxServiceRole,
      supportUri: row.s.supportUri,
      privacyPolicyUri: row.s.privacyPolicyUri,
      infoUri: row.s.infoUri,
      createdAt: row.s.createdAt,
    };
  }

  async services(tenantId: TenantId): Promise<SandboxServiceRecord[]> {
    const rows = await this.servicesQuery().where(eq(sandboxServices.tenantId, tenantId));
    return rows.map((r) => this.toService(r));
  }

  async service(tenantId: TenantId, id: string): Promise<SandboxServiceRecord | undefined> {
    const [row] = await this.servicesQuery().where(
      and(
        eq(sandboxServices.tenantId, tenantId),
        eq(sandboxServices.relyingPartyServiceId, id),
      ),
    );
    return row ? this.toService(row) : undefined;
  }

  async countServices(tenantId: TenantId): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(sandboxServices)
      .where(eq(sandboxServices.tenantId, tenantId));
    return row?.n ?? 0;
  }

  /** The organisation's Relying Party, created by the sandbox on its first service. */
  async relyingPartyOf(tenantId: TenantId): Promise<string | undefined> {
    const [row] = await this.db
      .select({ id: relyingParties.id })
      .from(relyingParties)
      .where(eq(relyingParties.tenantId, tenantId))
      .limit(1);
    return row?.id;
  }

  async organisationIdOf(
    tenantId: TenantId,
  ): Promise<{ organisationId: string; legalName: string } | undefined> {
    const [row] = await this.db
      .select({
        organisationId: sandboxOrganisations.organisationId,
        legalName: organisations.legalName,
      })
      .from(sandboxOrganisations)
      .innerJoin(organisations, eq(organisations.id, sandboxOrganisations.organisationId))
      .where(eq(sandboxOrganisations.tenantId, tenantId));
    return row;
  }

  async intendedUsesOf(tenantId: TenantId, serviceId: string) {
    return this.db
      .select()
      .from(intendedUses)
      .where(
        and(
          eq(intendedUses.tenantId, tenantId),
          eq(intendedUses.relyingPartyServiceId, serviceId),
        ),
      );
  }

  // --- certificates ----------------------------------------------------------------------------

  async nextStatusIndex(): Promise<number> {
    const result = await this.db.execute<{ n: string }>(
      sql`SELECT nextval('sandbox_status_index_seq') AS n`,
    );
    return Number(result.rows[0]?.n);
  }

  async createCertificate(record: SandboxCertificateRecord): Promise<void> {
    await this.db.insert(sandboxCertificates).values({
      id: record.id,
      tenantId: record.tenantId,
      relyingPartyServiceId: record.relyingPartyServiceId,
      intendedUseId: record.intendedUseId ?? null,
      kind: record.kind,
      variant: record.variant,
      issuerKey: record.issuerKey,
      serialHex: record.serialHex ?? null,
      statusIndex: record.statusIndex ?? null,
      notBefore: record.notBefore ?? null,
      notAfter: record.notAfter ?? null,
      body: record.body ?? null,
      fingerprintSha256: record.fingerprintSha256 ?? null,
      dnsNames: [...record.dnsNames],
      createdAt: record.createdAt,
      mode: record.mode,
    });
  }

  async certificates(
    tenantId: TenantId,
    serviceId?: string,
  ): Promise<SandboxCertificateRecord[]> {
    const rows = await this.db
      .select()
      .from(sandboxCertificates)
      .where(
        serviceId
          ? and(
              eq(sandboxCertificates.tenantId, tenantId),
              eq(sandboxCertificates.relyingPartyServiceId, serviceId),
            )
          : eq(sandboxCertificates.tenantId, tenantId),
      )
      .orderBy(desc(sandboxCertificates.createdAt));
    return rows.map(toCertificate);
  }

  async certificate(
    tenantId: TenantId,
    id: string,
  ): Promise<SandboxCertificateRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(sandboxCertificates)
      .where(and(eq(sandboxCertificates.tenantId, tenantId), eq(sandboxCertificates.id, id)));
    return row ? toCertificate(row) : undefined;
  }

  /** Revoke once: a revoked certificate is never reinstated (EN 319 411-1 REV-6.3.9-04). */
  async revoke(tenantId: TenantId, id: string, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(sandboxCertificates)
      .set({ revokedAt: at })
      .where(
        and(
          eq(sandboxCertificates.tenantId, tenantId),
          eq(sandboxCertificates.id, id),
          sql`${sandboxCertificates.revokedAt} IS NULL`,
        ),
      )
      .returning({ id: sandboxCertificates.id });
    return rows.length === 1;
  }

  /** Every revocation across the sandbox, for the CRLs and status lists. Public by nature. */
  async revocations(): Promise<
    { issuerKey: string; serialHex?: string; statusIndex?: number; revokedAt: Date }[]
  > {
    const rows = await this.db
      .select({
        issuerKey: sandboxCertificates.issuerKey,
        serialHex: sandboxCertificates.serialHex,
        statusIndex: sandboxCertificates.statusIndex,
        revokedAt: sandboxCertificates.revokedAt,
      })
      .from(sandboxCertificates)
      .where(isNotNull(sandboxCertificates.revokedAt));
    return rows.map((r) => ({
      issuerKey: r.issuerKey,
      ...(r.serialHex ? { serialHex: r.serialHex } : {}),
      ...(r.statusIndex !== null ? { statusIndex: r.statusIndex } : {}),
      revokedAt: r.revokedAt as Date,
    }));
  }

  /** The highest status index issued, to size the lists. */
  async maxStatusIndex(): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number | null>`max(${sandboxCertificates.statusIndex})` })
      .from(sandboxCertificates);
    return row?.n ?? -1;
  }

  // --- publications ----------------------------------------------------------------------------

  async latestPublication(channel: string): Promise<Publication | undefined> {
    const [row] = await this.db
      .select()
      .from(sandboxPublications)
      .where(eq(sandboxPublications.channel, channel))
      .orderBy(desc(sandboxPublications.sequence))
      .limit(1);
    return row ?? undefined;
  }

  async publish(
    channel: string,
    publication: Omit<Publication, "channel" | "sequence"> & { sequence: number },
    id: string,
  ) {
    await this.db.insert(sandboxPublications).values({ id, channel, ...publication });
  }

  // --- the register (TS5 read API) -------------------------------------------------------------

  /** Every active organisation with its services and intended uses: the public register. */
  async register() {
    const orgs = await this.db
      .select({
        o: sandboxOrganisations,
        legalName: organisations.legalName,
        isPsb: organisations.isPublicSectorBody,
      })
      .from(sandboxOrganisations)
      .innerJoin(organisations, eq(organisations.id, sandboxOrganisations.organisationId))
      .where(eq(sandboxOrganisations.status, "ACTIVE"));
    const services = await this.servicesQuery();
    const uses = await this.db.select().from(intendedUses);
    return orgs.map((org) => ({
      tenantId: org.o.tenantId,
      localIdentifier: org.o.localIdentifier,
      country: org.o.country,
      legalName: org.legalName,
      isPublicSectorBody: org.isPsb,
      services: services
        .filter((s) => s.s.tenantId === org.o.tenantId)
        .map((s) => ({
          ...this.toService(s),
          intendedUses: uses.filter(
            (u) => u.relyingPartyServiceId === s.s.relyingPartyServiceId,
          ),
        })),
    }));
  }
}
