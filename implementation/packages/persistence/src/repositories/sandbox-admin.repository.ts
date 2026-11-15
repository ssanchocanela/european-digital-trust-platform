import { sql } from "drizzle-orm";
import type { Database } from "../db.js";

/**
 * The sandbox operator's views (ADR 0019): read-only queries across every organisation, and the two
 * small operator actions that need no service of their own. Nothing here is reachable by a
 * participant — the admin controller checks the operator first.
 *
 * Parameterised throughout (`sql` template values are bound, never interpolated). No PID value, key
 * or token is selected, because none is stored; addresses are, because the operator sees them
 * (ADR 0019 §2).
 */
export interface AdminOverview {
  readonly activeOrganisations: number;
  readonly suspendedOrganisations: number;
  readonly people: number;
  readonly pendingInvitations: number;
  readonly certificates: number;
  readonly revokedCertificates: number;
  readonly runsLastDay: number;
  readonly offersLastDay: number;
}

export interface AdminOrganisationRow {
  readonly tenantId: string;
  readonly localIdentifier: string;
  readonly legalName: string;
  readonly country: string;
  readonly declaredEuid: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly suspendedAt: string | null;
  readonly members: number;
  readonly services: number;
  readonly verifiers: number;
  readonly issuers: number;
  readonly certificates: number;
}

export interface AdminServiceRow {
  readonly id: string;
  readonly role: string;
  readonly serviceIdentifier: string;
  readonly serviceTradeName: string;
  readonly createdAt: string;
  readonly hasVerifier: boolean;
  readonly hasIssuer: boolean;
  readonly certificatesLastDay: number;
  readonly runsLastDay: number;
  readonly offersLastDay: number;
}

export interface AdminCertificateRow {
  readonly id: string;
  readonly serviceId: string;
  readonly kind: string;
  readonly variant: string;
  readonly notAfter: string | null;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export interface AdminPersonRow {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly lastSignInAt: string;
  readonly pidPresented: boolean;
  readonly organisations: { identifier: string; role: string }[];
}

export interface AdminInvitationRow {
  readonly id: string;
  readonly tenantId: string;
  readonly organisation: string;
  readonly email: string | null;
  readonly role: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface AdminAuditRow {
  readonly at: string;
  readonly organisation: string | null;
  readonly actor: string;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string | null;
  readonly outcome: string | null;
}

const n = (v: unknown) => Number(v ?? 0);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown) => (v === null || v === undefined ? null : iso(v));

export class SandboxAdminRepository {
  constructor(private readonly db: Database) {}

  private async rows(query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
    const result = await this.db.execute(query);
    return result.rows as Record<string, unknown>[];
  }

  async overview(now: Date, since: Date): Promise<AdminOverview> {
    const [r] = await this.rows(sql`
      SELECT
        (SELECT count(*) FROM sandbox_organisations WHERE status = 'ACTIVE') AS active,
        (SELECT count(*) FROM sandbox_organisations WHERE status = 'SUSPENDED') AS suspended,
        (SELECT count(*) FROM sandbox_people) AS people,
        (SELECT count(*) FROM sandbox_invitations
           WHERE accepted_at IS NULL AND expires_at > ${now}) AS invitations,
        (SELECT count(*) FROM sandbox_certificates) AS certificates,
        (SELECT count(*) FROM sandbox_certificates WHERE revoked_at IS NOT NULL) AS revoked,
        (SELECT count(*) FROM sandbox_runs WHERE created_at >= ${since}) AS runs,
        (SELECT count(*) FROM sandbox_issuances WHERE created_at >= ${since}) AS offers`);
    return {
      activeOrganisations: n(r?.active),
      suspendedOrganisations: n(r?.suspended),
      people: n(r?.people),
      pendingInvitations: n(r?.invitations),
      certificates: n(r?.certificates),
      revokedCertificates: n(r?.revoked),
      runsLastDay: n(r?.runs),
      offersLastDay: n(r?.offers),
    };
  }

  private organisationQuery(where: ReturnType<typeof sql>) {
    return sql`
      SELECT so.tenant_id, so.local_identifier, o.legal_name, so.country, so.declared_euid,
             so.status, so.created_at, so.suspended_at,
             (SELECT count(*) FROM sandbox_memberships m WHERE m.tenant_id = so.tenant_id) AS members,
             (SELECT count(*) FROM sandbox_services s WHERE s.tenant_id = so.tenant_id) AS services,
             (SELECT count(*) FROM sandbox_verifiers v WHERE v.tenant_id = so.tenant_id) AS verifiers,
             (SELECT count(*) FROM sandbox_issuers i WHERE i.tenant_id = so.tenant_id) AS issuers,
             (SELECT count(*) FROM sandbox_certificates c WHERE c.tenant_id = so.tenant_id) AS certificates
        FROM sandbox_organisations so
        JOIN organisations o ON o.id = so.organisation_id
       ${where}
       ORDER BY so.created_at DESC`;
  }

  private toOrganisation(r: Record<string, unknown>): AdminOrganisationRow {
    return {
      tenantId: String(r.tenant_id),
      localIdentifier: String(r.local_identifier),
      legalName: String(r.legal_name),
      country: String(r.country),
      declaredEuid: r.declared_euid ? String(r.declared_euid) : null,
      status: String(r.status),
      createdAt: iso(r.created_at),
      suspendedAt: isoOrNull(r.suspended_at),
      members: n(r.members),
      services: n(r.services),
      verifiers: n(r.verifiers),
      issuers: n(r.issuers),
      certificates: n(r.certificates),
    };
  }

  async organisations(): Promise<AdminOrganisationRow[]> {
    return (await this.rows(this.organisationQuery(sql``))).map((r) => this.toOrganisation(r));
  }

  async organisation(tenantId: string): Promise<AdminOrganisationRow | undefined> {
    const [r] = await this.rows(this.organisationQuery(sql`WHERE so.tenant_id = ${tenantId}`));
    return r ? this.toOrganisation(r) : undefined;
  }

  async services(tenantId: string, since: Date): Promise<AdminServiceRow[]> {
    const rows = await this.rows(sql`
      SELECT s.relying_party_service_id AS id, s.role, rps.service_identifier,
             rps.service_trade_name, s.created_at,
             EXISTS (SELECT 1 FROM sandbox_verifiers v
                      WHERE v.relying_party_service_id = s.relying_party_service_id) AS has_verifier,
             EXISTS (SELECT 1 FROM sandbox_issuers i
                      WHERE i.relying_party_service_id = s.relying_party_service_id) AS has_issuer,
             (SELECT count(*) FROM sandbox_certificates c
               WHERE c.relying_party_service_id = s.relying_party_service_id
                 AND c.created_at >= ${since}) AS certificates_day,
             (SELECT count(*) FROM sandbox_runs r
               WHERE r.relying_party_service_id = s.relying_party_service_id
                 AND r.created_at >= ${since}) AS runs_day,
             (SELECT count(*) FROM sandbox_issuances x
               WHERE x.relying_party_service_id = s.relying_party_service_id
                 AND x.created_at >= ${since}) AS offers_day
        FROM sandbox_services s
        JOIN relying_party_services rps ON rps.id = s.relying_party_service_id
       WHERE s.tenant_id = ${tenantId}
       ORDER BY s.created_at`);
    return rows.map((r) => ({
      id: String(r.id),
      role: String(r.role),
      serviceIdentifier: String(r.service_identifier),
      serviceTradeName: String(r.service_trade_name),
      createdAt: iso(r.created_at),
      hasVerifier: Boolean(r.has_verifier),
      hasIssuer: Boolean(r.has_issuer),
      certificatesLastDay: n(r.certificates_day),
      runsLastDay: n(r.runs_day),
      offersLastDay: n(r.offers_day),
    }));
  }

  async certificates(tenantId: string): Promise<AdminCertificateRow[]> {
    const rows = await this.rows(sql`
      SELECT id, relying_party_service_id, kind, variant, not_after, created_at, revoked_at
        FROM sandbox_certificates
       WHERE tenant_id = ${tenantId}
       ORDER BY created_at DESC
       LIMIT 500`);
    return rows.map((r) => ({
      id: String(r.id),
      serviceId: String(r.relying_party_service_id),
      kind: String(r.kind),
      variant: String(r.variant),
      notAfter: isoOrNull(r.not_after),
      createdAt: iso(r.created_at),
      revokedAt: isoOrNull(r.revoked_at),
    }));
  }

  async people(): Promise<AdminPersonRow[]> {
    const rows = await this.rows(sql`
      SELECT p.id, p.email, p.display_name, p.created_at, p.last_sign_in_at,
             p.subject IS NOT NULL AS pid_presented,
             coalesce(json_agg(json_build_object('identifier', so.local_identifier, 'role', m.role))
                        FILTER (WHERE m.tenant_id IS NOT NULL), '[]') AS organisations
        FROM sandbox_people p
        LEFT JOIN sandbox_memberships m ON m.person_id = p.id
        LEFT JOIN sandbox_organisations so ON so.tenant_id = m.tenant_id
       GROUP BY p.id
       ORDER BY p.created_at DESC`);
    return rows.map((r) => ({
      id: String(r.id),
      email: String(r.email ?? ""),
      displayName: String(r.display_name),
      createdAt: iso(r.created_at),
      lastSignInAt: iso(r.last_sign_in_at),
      pidPresented: Boolean(r.pid_presented),
      organisations: (r.organisations as { identifier: string; role: string }[]) ?? [],
    }));
  }

  /** Pending invitations — unaccepted and unexpired — of every organisation, or of one. */
  async invitations(now: Date, tenantId?: string): Promise<AdminInvitationRow[]> {
    const rows = await this.rows(sql`
      SELECT i.id, i.tenant_id, so.local_identifier, i.email, i.role, i.created_at, i.expires_at
        FROM sandbox_invitations i
        JOIN sandbox_organisations so ON so.tenant_id = i.tenant_id
       WHERE i.accepted_at IS NULL AND i.expires_at > ${now}
         ${tenantId ? sql`AND i.tenant_id = ${tenantId}` : sql``}
       ORDER BY i.created_at DESC`);
    return rows.map((r) => ({
      id: String(r.id),
      tenantId: String(r.tenant_id),
      organisation: String(r.local_identifier),
      email: r.email ? String(r.email) : null,
      role: String(r.role),
      createdAt: iso(r.created_at),
      expiresAt: iso(r.expires_at),
    }));
  }

  /** The sandbox's audit records, newest first. Actions and ids only; `detail` is not read. */
  async audit(limit: number, tenantId?: string): Promise<AdminAuditRow[]> {
    const rows = await this.rows(sql`
      SELECT a.at, so.local_identifier, a.actor, a.action, a.subject_type, a.subject_id, a.outcome
        FROM audit_events a
        LEFT JOIN sandbox_organisations so ON so.tenant_id = a.tenant_id
       WHERE a.action LIKE 'sandbox.%'
         ${tenantId ? sql`AND a.tenant_id = ${tenantId}` : sql``}
       ORDER BY a.at DESC
       LIMIT ${limit}`);
    return rows.map((r) => ({
      at: iso(r.at),
      organisation: r.local_identifier ? String(r.local_identifier) : null,
      actor: String(r.actor),
      action: String(r.action),
      subjectType: String(r.subject_type),
      subjectId: r.subject_id ? String(r.subject_id) : null,
      outcome: r.outcome ? String(r.outcome) : null,
    }));
  }

  /**
   * Withdraw a pending invitation by expiring it now: it then fails `checkInvitation` as expired,
   * and an already-accepted one is untouched. Returns its organisation, or undefined if none matched.
   */
  async expireInvitation(id: string, at: Date): Promise<string | undefined> {
    const [r] = await this.rows(sql`
      UPDATE sandbox_invitations SET expires_at = ${at}
       WHERE id = ${id} AND accepted_at IS NULL AND expires_at > ${at}
       RETURNING tenant_id`);
    return r ? String(r.tenant_id) : undefined;
  }

  /** End every open session of a person at once. Returns how many were open. */
  async endSessionsOf(personId: string, at: Date): Promise<number> {
    const rows = await this.rows(sql`
      UPDATE sandbox_sessions SET ended_at = ${at}
       WHERE person_id = ${personId} AND ended_at IS NULL
       RETURNING token_hash`);
    return rows.length;
  }
}
