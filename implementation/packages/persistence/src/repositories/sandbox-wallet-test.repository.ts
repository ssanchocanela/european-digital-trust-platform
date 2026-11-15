import { asId, type TenantId } from "@edtp/shared";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Database } from "../db.js";
import { sandboxWalletTestRuns, sandboxWalletTestSteps } from "../schema.js";

/** Wallet test plan runs and their steps (ADR 0022). Every read names the tenant. */
export interface WalletTestRun {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly relyingPartyServiceId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly provider: string;
  readonly build: string;
  readonly platform: string;
  readonly createdAt: Date;
}

export interface WalletTestStep {
  readonly stepIndex: number;
  readonly refId: string;
  readonly startedAt: Date;
  readonly observation?: string;
  readonly note?: string;
  readonly observedAt?: Date;
}

export class SandboxWalletTestRepository {
  constructor(private readonly db: Database) {}

  async create(run: WalletTestRun): Promise<void> {
    await this.db.insert(sandboxWalletTestRuns).values(run);
  }

  async run(tenantId: TenantId, id: string): Promise<WalletTestRun | undefined> {
    const [r] = await this.db
      .select()
      .from(sandboxWalletTestRuns)
      .where(
        and(eq(sandboxWalletTestRuns.tenantId, tenantId), eq(sandboxWalletTestRuns.id, id)),
      );
    return r ? { ...r, tenantId: asId<"TenantId">(r.tenantId) } : undefined;
  }

  async runs(tenantId: TenantId): Promise<WalletTestRun[]> {
    const rows = await this.db
      .select()
      .from(sandboxWalletTestRuns)
      .where(eq(sandboxWalletTestRuns.tenantId, tenantId))
      .orderBy(desc(sandboxWalletTestRuns.createdAt));
    return rows.map((r) => ({ ...r, tenantId: asId<"TenantId">(r.tenantId) }));
  }

  async steps(planRunId: string): Promise<WalletTestStep[]> {
    const rows = await this.db
      .select()
      .from(sandboxWalletTestSteps)
      .where(eq(sandboxWalletTestSteps.planRunId, planRunId))
      .orderBy(asc(sandboxWalletTestSteps.stepIndex));
    return rows.map((r) => ({
      stepIndex: r.stepIndex,
      refId: r.refId,
      startedAt: r.startedAt,
      ...(r.observation ? { observation: r.observation } : {}),
      ...(r.note ? { note: r.note } : {}),
      ...(r.observedAt ? { observedAt: r.observedAt } : {}),
    }));
  }

  /** Start (or restart) a step: a fresh run replaces the previous one and its observation. */
  async startStep(
    planRunId: string,
    stepIndex: number,
    refId: string,
    at: Date,
  ): Promise<void> {
    await this.db
      .insert(sandboxWalletTestSteps)
      .values({ planRunId, stepIndex, refId, startedAt: at })
      .onConflictDoUpdate({
        target: [sandboxWalletTestSteps.planRunId, sandboxWalletTestSteps.stepIndex],
        set: { refId, startedAt: at, observation: null, note: null, observedAt: null },
      });
  }

  async observe(
    planRunId: string,
    stepIndex: number,
    observation: string,
    note: string | undefined,
    at: Date,
  ): Promise<boolean> {
    const rows = await this.db
      .update(sandboxWalletTestSteps)
      .set({ observation, note: note ?? null, observedAt: at })
      .where(
        and(
          eq(sandboxWalletTestSteps.planRunId, planRunId),
          eq(sandboxWalletTestSteps.stepIndex, stepIndex),
        ),
      )
      .returning({ i: sandboxWalletTestSteps.stepIndex });
    return rows.length === 1;
  }
}
