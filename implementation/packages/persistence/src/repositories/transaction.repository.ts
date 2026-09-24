import {
  assertDeliveryTransition,
  assertTransition,
  type DeliveryStatus,
  type InteractionType,
  isTerminal,
  type NormalisedClaims,
  type PresentationResult,
  type PresentationState,
  type PresentationTransaction,
  type PresentationTransactionTransition,
} from "@edtp/domain";
import type { PresentationId, TenantId } from "@edtp/shared";
import { asId, PlatformError } from "@edtp/shared";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { Database } from "../db.js";
import {
  presentationResults,
  presentationTransactions,
  presentationTransactionTransitions,
} from "../schema.js";

/**
 * Presentation transaction repository.
 *
 * State changes go through {@link transition}, which validates against the domain
 * transition table **and** applies the change with the expected prior state in the
 * `WHERE` clause. That second part matters: two concurrent pollers could each read
 * `VERIFYING` and each try to settle the transaction, and a plain update would let both
 * succeed. Here the loser affects zero rows and is told so.
 */
export class TransactionRepository {
  constructor(private readonly db: Database) {}

  async create(tx: PresentationTransaction): Promise<PresentationTransaction> {
    await this.db.insert(presentationTransactions).values({
      id: tx.id,
      tenantId: tx.tenantId,
      relyingPartyServiceId: tx.relyingPartyServiceId,
      policyId: tx.policyId,
      policyVersion: tx.policyVersion,
      businessReference: tx.businessReference,
      state: tx.state,
      interactionType: tx.interactionType,
      deliveryStatus: tx.deliveryStatus,
      callbackUrl: tx.callbackUrl ?? null,
      engineSessionRef: tx.engineSessionRef ?? null,
      engineTenantRef: null,
      failureCode: tx.failureCode ?? null,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
      expiresAt: tx.expiresAt,
      closedAt: tx.closedAt ?? null,
    });
    await this.appendTransition(tx.id, 0, tx.state, tx.state, "created", tx.createdAt);
    return tx;
  }

  async find(
    tenantId: TenantId,
    id: PresentationId,
  ): Promise<PresentationTransaction | undefined> {
    const [row] = await this.db
      .select()
      .from(presentationTransactions)
      .where(
        and(
          eq(presentationTransactions.tenantId, tenantId),
          eq(presentationTransactions.id, id),
        ),
      )
      .limit(1);
    return row ? mapTransaction(row) : undefined;
  }

  /** The engine tenant a transaction's session belongs to, for the stateless adapter. */
  async findEngineSession(
    tenantId: TenantId,
    id: PresentationId,
  ): Promise<{ readonly ref: string; readonly engineTenantRef: string } | undefined> {
    const [row] = await this.db
      .select({
        ref: presentationTransactions.engineSessionRef,
        engineTenantRef: presentationTransactions.engineTenantRef,
      })
      .from(presentationTransactions)
      .where(
        and(
          eq(presentationTransactions.tenantId, tenantId),
          eq(presentationTransactions.id, id),
        ),
      )
      .limit(1);
    if (!row?.ref || !row.engineTenantRef) return undefined;
    return { ref: row.ref, engineTenantRef: row.engineTenantRef };
  }

  /** Records the engine session once the request has been created. */
  async attachEngineSession(
    tenantId: TenantId,
    id: PresentationId,
    session: { readonly ref: string; readonly engineTenantRef: string },
    sentWithoutRegistrationCertificate: boolean,
    at: Date,
  ): Promise<void> {
    await this.db
      .update(presentationTransactions)
      .set({
        engineSessionRef: session.ref,
        engineTenantRef: session.engineTenantRef,
        sentWithoutRegistrationCertificate,
        updatedAt: at,
      })
      .where(
        and(
          eq(presentationTransactions.tenantId, tenantId),
          eq(presentationTransactions.id, id),
        ),
      );
  }

  /**
   * Moves a transaction to a new state.
   *
   * Validates the transition in the domain, then applies it conditionally on the prior
   * state so a concurrent writer cannot also apply it. `closedAt` is set exactly when the
   * new state is terminal.
   */
  async transition(
    tenantId: TenantId,
    id: PresentationId,
    from: PresentationState,
    to: PresentationState,
    reason: string,
    at: Date,
    extra?: { readonly failureCode?: string },
  ): Promise<void> {
    assertTransition(from, to);

    const updated = await this.db
      .update(presentationTransactions)
      .set({
        state: to,
        updatedAt: at,
        ...(isTerminal(to) ? { closedAt: at } : {}),
        ...(extra?.failureCode ? { failureCode: extra.failureCode } : {}),
      })
      .where(
        and(
          eq(presentationTransactions.tenantId, tenantId),
          eq(presentationTransactions.id, id),
          eq(presentationTransactions.state, from),
        ),
      )
      .returning({ id: presentationTransactions.id });

    if (updated.length === 0) {
      throw PlatformError.conflict(
        "transaction_state_changed",
        `The transaction is no longer in state ${from}, so it could not be moved to ${to}.`,
      );
    }

    await this.appendNextTransition(id, from, to, reason, at);
  }

  async setDeliveryStatus(
    tenantId: TenantId,
    id: PresentationId,
    from: DeliveryStatus,
    to: DeliveryStatus,
    at: Date,
  ): Promise<void> {
    assertDeliveryTransition(from, to);
    await this.db
      .update(presentationTransactions)
      .set({ deliveryStatus: to, updatedAt: at })
      .where(
        and(
          eq(presentationTransactions.tenantId, tenantId),
          eq(presentationTransactions.id, id),
          eq(presentationTransactions.deliveryStatus, from),
        ),
      );
  }

  async listTransitions(
    id: PresentationId,
  ): Promise<readonly PresentationTransactionTransition[]> {
    const rows = await this.db
      .select()
      .from(presentationTransactionTransitions)
      .where(eq(presentationTransactionTransitions.presentationId, id))
      .orderBy(asc(presentationTransactionTransitions.sequence));
    return rows.map((r) => ({
      presentationId: asId<"PresentationId">(r.presentationId),
      sequence: r.sequence,
      fromState: r.fromState as PresentationState,
      toState: r.toState as PresentationState,
      reason: r.reason,
      at: r.at,
    }));
  }

  /** Non-terminal transactions whose lifetime has elapsed, for the expiry job. */
  async findExpirable(at: Date, limit = 100): Promise<readonly PresentationTransaction[]> {
    const rows = await this.db
      .select()
      .from(presentationTransactions)
      .where(
        and(
          lte(presentationTransactions.expiresAt, at),
          sql`${presentationTransactions.closedAt} IS NULL`,
        ),
      )
      .limit(limit);
    return rows.map(mapTransaction);
  }

  // --- results -------------------------------------------------------------

  async saveResult(result: PresentationResult): Promise<void> {
    await this.db
      .insert(presentationResults)
      .values({
        presentationId: result.presentationId,
        tenantId: result.tenantId,
        claims: result.claims,
        createdAt: result.createdAt,
        purgeAfter: result.purgeAfter,
      })
      .onConflictDoNothing();
  }

  async findResult(
    tenantId: TenantId,
    id: PresentationId,
  ): Promise<PresentationResult | undefined> {
    const [row] = await this.db
      .select()
      .from(presentationResults)
      .where(
        and(
          eq(presentationResults.tenantId, tenantId),
          eq(presentationResults.presentationId, id),
        ),
      )
      .limit(1);
    if (!row) return undefined;
    return {
      presentationId: asId<"PresentationId">(row.presentationId),
      tenantId: asId<"TenantId">(row.tenantId),
      claims: row.claims as NormalisedClaims,
      createdAt: row.createdAt,
      purgeAfter: row.purgeAfter,
    };
  }

  /**
   * Deletes results whose retention window has elapsed.
   *
   * Transaction metadata and the audit trail survive, so a purged result leaves evidence
   * that a verification happened without leaving the values behind.
   */
  async purgeExpiredResults(at: Date): Promise<number> {
    const deleted = await this.db
      .delete(presentationResults)
      .where(lte(presentationResults.purgeAfter, at))
      .returning({ id: presentationResults.presentationId });
    return deleted.length;
  }

  // --- internals -----------------------------------------------------------

  private async appendNextTransition(
    id: PresentationId,
    from: PresentationState,
    to: PresentationState,
    reason: string,
    at: Date,
  ): Promise<void> {
    const [last] = await this.db
      .select({ sequence: presentationTransactionTransitions.sequence })
      .from(presentationTransactionTransitions)
      .where(eq(presentationTransactionTransitions.presentationId, id))
      .orderBy(sql`${presentationTransactionTransitions.sequence} DESC`)
      .limit(1);
    await this.appendTransition(id, (last?.sequence ?? 0) + 1, from, to, reason, at);
  }

  private async appendTransition(
    id: PresentationId,
    sequence: number,
    from: PresentationState,
    to: PresentationState,
    reason: string,
    at: Date,
  ): Promise<void> {
    await this.db
      .insert(presentationTransactionTransitions)
      .values({ presentationId: id, sequence, fromState: from, toState: to, reason, at })
      .onConflictDoNothing();
  }
}

type TransactionRow = typeof presentationTransactions.$inferSelect;

const mapTransaction = (row: TransactionRow): PresentationTransaction => ({
  id: asId<"PresentationId">(row.id),
  tenantId: asId<"TenantId">(row.tenantId),
  relyingPartyServiceId: asId<"RelyingPartyServiceId">(row.relyingPartyServiceId),
  policyId: asId<"PresentationPolicyId">(row.policyId),
  policyVersion: row.policyVersion,
  businessReference: row.businessReference,
  state: row.state as PresentationState,
  interactionType: row.interactionType as InteractionType,
  deliveryStatus: row.deliveryStatus as DeliveryStatus,
  ...(row.callbackUrl ? { callbackUrl: row.callbackUrl } : {}),
  ...(row.engineSessionRef
    ? { engineSessionRef: asId<"EngineSessionRef">(row.engineSessionRef) }
    : {}),
  ...(row.failureCode ? { failureCode: row.failureCode } : {}),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  expiresAt: row.expiresAt,
  ...(row.closedAt ? { closedAt: row.closedAt } : {}),
});
