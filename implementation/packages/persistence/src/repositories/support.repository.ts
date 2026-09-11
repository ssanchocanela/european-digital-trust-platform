import { createHash } from "node:crypto";
import type { AuditEventId, PresentationId, TenantId, WebhookDeliveryId } from "@edtp/shared";
import { asId, redact } from "@edtp/shared";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { Database } from "../db.js";
import { apiKeys, auditEvents, webhookDeliveries } from "../schema.js";

/**
 * Development API keys.
 *
 * One key per tenant. Only a SHA-256 hash is stored, with a short non-secret prefix used
 * to find the row, so a database dump yields no usable credential. The prefix is
 * indexed, so authentication is one indexed lookup plus one constant-time comparison
 * rather than a scan over every key.
 *
 * This is a documented **development** mechanism — see `docs/security-limitations.md`.
 */
export const API_KEY_PREFIX_LENGTH = 12;

export const hashApiKey = (key: string): string =>
  createHash("sha256").update(key, "utf8").digest("hex");

export class ApiKeyRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    readonly id: string;
    readonly tenantId: TenantId;
    readonly key: string;
    readonly label: string;
    readonly createdAt: Date;
  }): Promise<void> {
    await this.db.insert(apiKeys).values({
      id: input.id,
      tenantId: input.tenantId,
      keyPrefix: input.key.slice(0, API_KEY_PREFIX_LENGTH),
      keyHash: hashApiKey(input.key),
      label: input.label,
      createdAt: input.createdAt,
    });
  }

  /** Resolves a presented key to its tenant, or undefined if unknown or revoked. */
  async resolveTenant(key: string): Promise<TenantId | undefined> {
    if (key.length <= API_KEY_PREFIX_LENGTH) return undefined;
    const [row] = await this.db
      .select({
        tenantId: apiKeys.tenantId,
        keyHash: apiKeys.keyHash,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.keyPrefix, key.slice(0, API_KEY_PREFIX_LENGTH)))
      .limit(1);
    if (!row || row.revokedAt) return undefined;
    return timingSafeEqualHex(row.keyHash, hashApiKey(key))
      ? asId<"TenantId">(row.tenantId)
      : undefined;
  }
}

/** Constant-time comparison of two equal-length hex digests. */
const timingSafeEqualHex = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export interface AuditEventInput {
  readonly id: AuditEventId;
  readonly tenantId: TenantId;
  readonly at: Date;
  readonly actor: string;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId?: string;
  readonly policyId?: string;
  readonly policyVersion?: number;
  readonly outcome?: string;
  readonly correlationId?: string;
  readonly detail?: Record<string, unknown>;
}

/**
 * Audit evidence.
 *
 * `detail` is passed through the same redaction deny-list the logger uses before it is
 * written, so an audit row cannot become a back door for presentation content. That is
 * deliberate: the audit trail records that a verification happened, under which policy
 * version and with what outcome — not what was disclosed.
 */
export class AuditRepository {
  constructor(private readonly db: Database) {}

  async record(event: AuditEventInput): Promise<void> {
    await this.db.insert(auditEvents).values({
      id: event.id,
      tenantId: event.tenantId,
      at: event.at,
      actor: event.actor,
      action: event.action,
      subjectType: event.subjectType,
      subjectId: event.subjectId ?? null,
      policyId: event.policyId ?? null,
      policyVersion: event.policyVersion ?? null,
      outcome: event.outcome ?? null,
      correlationId: event.correlationId ?? null,
      detail: event.detail ? (redact(event.detail) as Record<string, unknown>) : null,
    });
  }

  async listForSubject(
    tenantId: TenantId,
    subjectType: string,
    subjectId: string,
  ): Promise<readonly AuditEventInput[]> {
    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, tenantId),
          eq(auditEvents.subjectType, subjectType),
          eq(auditEvents.subjectId, subjectId),
        ),
      )
      .orderBy(asc(auditEvents.at));
    return rows.map((r) => ({
      id: asId<"AuditEventId">(r.id),
      tenantId: asId<"TenantId">(r.tenantId),
      at: r.at,
      actor: r.actor,
      action: r.action,
      subjectType: r.subjectType,
      ...(r.subjectId ? { subjectId: r.subjectId } : {}),
      ...(r.policyId ? { policyId: r.policyId } : {}),
      ...(r.policyVersion !== null ? { policyVersion: r.policyVersion } : {}),
      ...(r.outcome ? { outcome: r.outcome } : {}),
      ...(r.correlationId ? { correlationId: r.correlationId } : {}),
      ...(r.detail ? { detail: r.detail as Record<string, unknown> } : {}),
    }));
  }
}

export const DELIVERY_QUEUE_STATUSES = ["PENDING", "DELIVERED", "FAILED"] as const;
export type DeliveryQueueStatus = (typeof DELIVERY_QUEUE_STATUSES)[number];

export interface WebhookDeliveryRecord {
  readonly id: WebhookDeliveryId;
  readonly tenantId: TenantId;
  readonly presentationId: PresentationId;
  readonly eventId: string;
  readonly url: string;
  readonly payload: Record<string, unknown>;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly status: DeliveryQueueStatus;
  readonly nextAttemptAt: Date;
  readonly lastError?: string;
}

/**
 * Outbound delivery queue.
 *
 * A table rather than a broker, per ADR 0003. `eventId` is unique, so enqueueing the
 * same event twice is a no-op and a receiver can deduplicate on it.
 */
export class WebhookDeliveryRepository {
  constructor(private readonly db: Database) {}

  async enqueue(record: WebhookDeliveryRecord, at: Date): Promise<void> {
    await this.db
      .insert(webhookDeliveries)
      .values({
        id: record.id,
        tenantId: record.tenantId,
        presentationId: record.presentationId,
        eventId: record.eventId,
        url: record.url,
        payload: record.payload,
        attempt: record.attempt,
        maxAttempts: record.maxAttempts,
        status: record.status,
        nextAttemptAt: record.nextAttemptAt,
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoNothing({ target: webhookDeliveries.eventId });
  }

  /** Claims due deliveries. `FOR UPDATE SKIP LOCKED` keeps concurrent workers disjoint. */
  async claimDue(at: Date, limit = 20): Promise<readonly WebhookDeliveryRecord[]> {
    const rows = await this.db
      .select()
      .from(webhookDeliveries)
      .where(
        and(eq(webhookDeliveries.status, "PENDING"), lte(webhookDeliveries.nextAttemptAt, at)),
      )
      .orderBy(asc(webhookDeliveries.nextAttemptAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    return rows.map((r) => ({
      id: asId<"WebhookDeliveryId">(r.id),
      tenantId: asId<"TenantId">(r.tenantId),
      presentationId: asId<"PresentationId">(r.presentationId),
      eventId: r.eventId,
      url: r.url,
      payload: r.payload as Record<string, unknown>,
      attempt: r.attempt,
      maxAttempts: r.maxAttempts,
      status: r.status as DeliveryQueueStatus,
      nextAttemptAt: r.nextAttemptAt,
      ...(r.lastError ? { lastError: r.lastError } : {}),
    }));
  }

  async markDelivered(id: WebhookDeliveryId, at: Date): Promise<void> {
    await this.db
      .update(webhookDeliveries)
      .set({
        status: "DELIVERED",
        updatedAt: at,
        attempt: sql`${webhookDeliveries.attempt} + 1`,
      })
      .where(eq(webhookDeliveries.id, id));
  }

  /** Records a failed attempt, scheduling the next one or giving up at the cap. */
  async recordFailure(
    id: WebhookDeliveryId,
    attempt: number,
    maxAttempts: number,
    nextAttemptAt: Date,
    error: string,
    at: Date,
  ): Promise<void> {
    const exhausted = attempt + 1 >= maxAttempts;
    await this.db
      .update(webhookDeliveries)
      .set({
        attempt: attempt + 1,
        status: exhausted ? "FAILED" : "PENDING",
        nextAttemptAt,
        // Truncated: a remote error body is untrusted input and must not become an
        // unbounded column, and it must never carry content back into storage.
        lastError: error.slice(0, 500),
        updatedAt: at,
      })
      .where(eq(webhookDeliveries.id, id));
  }
}
