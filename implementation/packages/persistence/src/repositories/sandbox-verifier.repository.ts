import { asId, type TenantId } from "@edtp/shared";
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db.js";
import { sandboxRuns, sandboxVerifiers, sandboxVerifierUses } from "../schema.js";

/** The sandbox's hosted verifiers and their run reports (S4). Every read names the tenant. */
export interface SandboxVerifierRecord {
  readonly relyingPartyServiceId: string;
  readonly tenantId: TenantId;
  readonly engineTenantRef: string;
  readonly accessCertificateId: string;
  readonly configuredAt: Date;
  readonly uses: readonly {
    intendedUseId: string;
    registrationCertificateId: string;
    policyId: string;
  }[];
}

export const RUN_OBSERVATIONS = [
  "refused_before_consent",
  "warned_user_stopped",
  "warned_user_continued",
  "presented_without_warning",
  "error_shown",
  "nothing_happened",
  "other",
] as const;
export type RunObservation = (typeof RUN_OBSERVATIONS)[number];

export interface SandboxRunRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly relyingPartyServiceId: string;
  readonly intendedUseId: string;
  readonly presentationId: string;
  readonly accessCertificateId: string;
  readonly registrationCertificateId: string;
  readonly interaction: "SAME_DEVICE" | "QR";
  readonly createdAt: Date;
  readonly walletBuild?: string;
  readonly checkRegistrationCertificates?: "on" | "off" | "unknown";
  readonly observation?: RunObservation;
  readonly observationNote?: string;
  readonly observedAt?: Date;
}

const toRun = (r: typeof sandboxRuns.$inferSelect): SandboxRunRecord => ({
  id: r.id,
  tenantId: asId<"TenantId">(r.tenantId),
  relyingPartyServiceId: r.relyingPartyServiceId,
  intendedUseId: r.intendedUseId,
  presentationId: r.presentationId,
  accessCertificateId: r.accessCertificateId,
  registrationCertificateId: r.registrationCertificateId,
  interaction: r.interaction as SandboxRunRecord["interaction"],
  createdAt: r.createdAt,
  ...(r.walletBuild ? { walletBuild: r.walletBuild } : {}),
  ...(r.checkRegistrationCertificates
    ? {
        checkRegistrationCertificates: r.checkRegistrationCertificates as
          | "on"
          | "off"
          | "unknown",
      }
    : {}),
  ...(r.observation ? { observation: r.observation as RunObservation } : {}),
  ...(r.observationNote ? { observationNote: r.observationNote } : {}),
  ...(r.observedAt ? { observedAt: r.observedAt } : {}),
});

export class SandboxVerifierRepository {
  constructor(private readonly db: Database) {}

  async verifier(
    tenantId: TenantId,
    serviceId: string,
  ): Promise<SandboxVerifierRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(sandboxVerifiers)
      .where(
        and(
          eq(sandboxVerifiers.tenantId, tenantId),
          eq(sandboxVerifiers.relyingPartyServiceId, serviceId),
        ),
      );
    if (!row) return undefined;
    const uses = await this.db
      .select()
      .from(sandboxVerifierUses)
      .where(eq(sandboxVerifierUses.relyingPartyServiceId, serviceId));
    return {
      relyingPartyServiceId: row.relyingPartyServiceId,
      tenantId: asId<"TenantId">(row.tenantId),
      engineTenantRef: row.engineTenantRef,
      accessCertificateId: row.accessCertificateId,
      configuredAt: row.configuredAt,
      uses: uses.map((u) => ({
        intendedUseId: u.intendedUseId,
        registrationCertificateId: u.registrationCertificateId,
        policyId: u.policyId,
      })),
    };
  }

  async createVerifier(input: {
    relyingPartyServiceId: string;
    tenantId: TenantId;
    engineTenantRef: string;
    accessCertificateId: string;
    at: Date;
  }): Promise<void> {
    await this.db.insert(sandboxVerifiers).values({
      relyingPartyServiceId: input.relyingPartyServiceId,
      tenantId: input.tenantId,
      engineTenantRef: input.engineTenantRef,
      accessCertificateId: input.accessCertificateId,
      configuredAt: input.at,
      createdAt: input.at,
    });
  }

  async setAccessCertificate(
    tenantId: TenantId,
    serviceId: string,
    certificateId: string,
    at: Date,
  ): Promise<void> {
    await this.db
      .update(sandboxVerifiers)
      .set({ accessCertificateId: certificateId, configuredAt: at })
      .where(
        and(
          eq(sandboxVerifiers.tenantId, tenantId),
          eq(sandboxVerifiers.relyingPartyServiceId, serviceId),
        ),
      );
  }

  async setUse(input: {
    relyingPartyServiceId: string;
    intendedUseId: string;
    registrationCertificateId: string;
    policyId: string;
    at: Date;
  }): Promise<void> {
    await this.db
      .insert(sandboxVerifierUses)
      .values({ ...input, configuredAt: input.at })
      .onConflictDoUpdate({
        target: sandboxVerifierUses.intendedUseId,
        set: {
          registrationCertificateId: input.registrationCertificateId,
          configuredAt: input.at,
        },
      });
  }

  async createRun(run: SandboxRunRecord): Promise<void> {
    await this.db.insert(sandboxRuns).values({
      id: run.id,
      tenantId: run.tenantId,
      relyingPartyServiceId: run.relyingPartyServiceId,
      intendedUseId: run.intendedUseId,
      presentationId: run.presentationId,
      accessCertificateId: run.accessCertificateId,
      registrationCertificateId: run.registrationCertificateId,
      interaction: run.interaction,
      createdAt: run.createdAt,
    });
  }

  async run(tenantId: TenantId, id: string): Promise<SandboxRunRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(sandboxRuns)
      .where(and(eq(sandboxRuns.tenantId, tenantId), eq(sandboxRuns.id, id)));
    return row ? toRun(row) : undefined;
  }

  async runs(tenantId: TenantId): Promise<SandboxRunRecord[]> {
    const rows = await this.db
      .select()
      .from(sandboxRuns)
      .where(eq(sandboxRuns.tenantId, tenantId))
      .orderBy(desc(sandboxRuns.createdAt))
      .limit(200);
    return rows.map(toRun);
  }

  async observe(
    tenantId: TenantId,
    id: string,
    input: {
      walletBuild: string;
      checkRegistrationCertificates: "on" | "off" | "unknown";
      observation: RunObservation;
      observationNote?: string;
      at: Date;
    },
  ): Promise<boolean> {
    const rows = await this.db
      .update(sandboxRuns)
      .set({
        walletBuild: input.walletBuild,
        checkRegistrationCertificates: input.checkRegistrationCertificates,
        observation: input.observation,
        observationNote: input.observationNote ?? null,
        observedAt: input.at,
      })
      .where(and(eq(sandboxRuns.tenantId, tenantId), eq(sandboxRuns.id, id)))
      .returning({ id: sandboxRuns.id });
    return rows.length === 1;
  }
}
