import { asId, type TenantId } from "@edtp/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db.js";
import { sandboxOrganisations, sandboxWalletProviderAnchors } from "../schema.js";

/**
 * Wallet Provider anchors (ADR 0020). Every participant read names its tenant and service; the
 * operator's and the publication's reads span organisations, and are reached only through the
 * operator check or the list.
 */
export type WalletProviderAnchorStatus = "PENDING" | "APPROVED" | "REFUSED" | "WITHDRAWN";

export interface WalletProviderAnchor {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly relyingPartyServiceId: string;
  readonly kind: "ca" | "signer";
  /** Base64 DER. Public by nature: it is what the list publishes. */
  readonly certificateDer: string;
  readonly fingerprint: string;
  readonly subject: string;
  readonly notAfter: Date;
  readonly status: WalletProviderAnchorStatus;
  readonly reason?: string;
  readonly createdAt: Date;
  readonly decidedAt?: Date;
}

const toAnchor = (
  r: typeof sandboxWalletProviderAnchors.$inferSelect,
): WalletProviderAnchor => ({
  id: r.id,
  tenantId: asId<"TenantId">(r.tenantId),
  relyingPartyServiceId: r.relyingPartyServiceId,
  kind: r.kind as WalletProviderAnchor["kind"],
  certificateDer: r.certificateDer,
  fingerprint: r.fingerprint,
  subject: r.subject,
  notAfter: r.notAfter,
  status: r.status as WalletProviderAnchorStatus,
  ...(r.reason ? { reason: r.reason } : {}),
  createdAt: r.createdAt,
  ...(r.decidedAt ? { decidedAt: r.decidedAt } : {}),
});

export class SandboxWalletProviderRepository {
  constructor(private readonly db: Database) {}

  async create(anchor: WalletProviderAnchor): Promise<void> {
    await this.db.insert(sandboxWalletProviderAnchors).values({
      id: anchor.id,
      tenantId: anchor.tenantId,
      relyingPartyServiceId: anchor.relyingPartyServiceId,
      kind: anchor.kind,
      certificateDer: anchor.certificateDer,
      fingerprint: anchor.fingerprint,
      subject: anchor.subject,
      notAfter: anchor.notAfter,
      status: anchor.status,
      createdAt: anchor.createdAt,
    });
  }

  /** A service's anchors, newest first. */
  async ofService(tenantId: TenantId, serviceId: string): Promise<WalletProviderAnchor[]> {
    const rows = await this.db
      .select()
      .from(sandboxWalletProviderAnchors)
      .where(
        and(
          eq(sandboxWalletProviderAnchors.tenantId, tenantId),
          eq(sandboxWalletProviderAnchors.relyingPartyServiceId, serviceId),
        ),
      )
      .orderBy(desc(sandboxWalletProviderAnchors.createdAt));
    return rows.map(toAnchor);
  }

  /** Pending or approved anchors of a service: the ones that count against its limit. */
  async countLive(tenantId: TenantId, serviceId: string): Promise<number> {
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(sandboxWalletProviderAnchors)
      .where(
        and(
          eq(sandboxWalletProviderAnchors.tenantId, tenantId),
          eq(sandboxWalletProviderAnchors.relyingPartyServiceId, serviceId),
          inArray(sandboxWalletProviderAnchors.status, ["PENDING", "APPROVED"]),
        ),
      );
    return r?.n ?? 0;
  }

  async isLive(fingerprint: string): Promise<boolean> {
    const [r] = await this.db
      .select({ id: sandboxWalletProviderAnchors.id })
      .from(sandboxWalletProviderAnchors)
      .where(
        and(
          eq(sandboxWalletProviderAnchors.fingerprint, fingerprint),
          inArray(sandboxWalletProviderAnchors.status, ["PENDING", "APPROVED"]),
        ),
      );
    return Boolean(r);
  }

  async find(id: string): Promise<WalletProviderAnchor | undefined> {
    const [r] = await this.db
      .select()
      .from(sandboxWalletProviderAnchors)
      .where(eq(sandboxWalletProviderAnchors.id, id));
    return r ? toAnchor(r) : undefined;
  }

  /**
   * Move an anchor from one status to another, once: the update matches only the expected current
   * status, so a double click or a race cannot approve a withdrawn anchor. False when it did not match.
   */
  async decide(
    id: string,
    from: readonly WalletProviderAnchorStatus[],
    to: WalletProviderAnchorStatus,
    at: Date,
    reason?: string,
  ): Promise<boolean> {
    const rows = await this.db
      .update(sandboxWalletProviderAnchors)
      .set({ status: to, decidedAt: at, reason: reason ?? null })
      .where(
        and(
          eq(sandboxWalletProviderAnchors.id, id),
          inArray(sandboxWalletProviderAnchors.status, [...from]),
        ),
      )
      .returning({ id: sandboxWalletProviderAnchors.id });
    return rows.length === 1;
  }

  /** Every anchor, for the operator, with its organisation's identifier and status. */
  async all(): Promise<
    (WalletProviderAnchor & { organisation: string; organisationStatus: string })[]
  > {
    const rows = await this.db
      .select({
        a: sandboxWalletProviderAnchors,
        organisation: sandboxOrganisations.localIdentifier,
        organisationStatus: sandboxOrganisations.status,
      })
      .from(sandboxWalletProviderAnchors)
      .innerJoin(
        sandboxOrganisations,
        eq(sandboxOrganisations.tenantId, sandboxWalletProviderAnchors.tenantId),
      )
      .orderBy(desc(sandboxWalletProviderAnchors.createdAt));
    return rows.map((r) => ({
      ...toAnchor(r.a),
      organisation: r.organisation,
      organisationStatus: r.organisationStatus,
    }));
  }

  /**
   * What the Wallet Providers list carries from participants: approved, unexpired, and of an ACTIVE
   * organisation — so suspending an organisation takes its anchors off at the next publication.
   */
  async listed(now: Date): Promise<(WalletProviderAnchor & { organisation: string })[]> {
    const rows = await this.db
      .select({
        a: sandboxWalletProviderAnchors,
        organisation: sandboxOrganisations.localIdentifier,
      })
      .from(sandboxWalletProviderAnchors)
      .innerJoin(
        sandboxOrganisations,
        eq(sandboxOrganisations.tenantId, sandboxWalletProviderAnchors.tenantId),
      )
      .where(
        and(
          eq(sandboxWalletProviderAnchors.status, "APPROVED"),
          eq(sandboxOrganisations.status, "ACTIVE"),
          sql`${sandboxWalletProviderAnchors.notAfter} > ${now}`,
        ),
      )
      .orderBy(sandboxWalletProviderAnchors.fingerprint);
    return rows.map((r) => ({ ...toAnchor(r.a), organisation: r.organisation }));
  }
}
