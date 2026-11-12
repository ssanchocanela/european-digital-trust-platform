import { createHash } from "node:crypto";
import type {
  Invitation,
  InvitationId,
  Membership,
  Person,
  PersonId,
  Role,
  SandboxOrganisation,
  Session,
  SignInAttemptId,
  SignInPurpose,
} from "@edtp/sandbox-domain";
import { formatSandboxIdentifier } from "@edtp/sandbox-domain";
import { asId, type TenantId } from "@edtp/shared";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database } from "../db.js";
import {
  apiKeys,
  organisations,
  sandboxInvitations,
  sandboxMemberships,
  sandboxOrganisations,
  sandboxPeople,
  sandboxSessions,
  sandboxSignInAttempts,
  tenants,
} from "../schema.js";

/**
 * The sandbox's people and organisations (ADR 0015).
 *
 * Every secret a browser holds — session, invitation, sign-in binding — is presented in full and
 * stored as its SHA-256, so the table never contains a usable token. Every query that reads an
 * organisation's data names the tenant; a person reaches an organisation only through a membership.
 */
export const hashSandboxToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

export interface NewSandboxOrganisation {
  readonly tenantId: TenantId;
  readonly organisationId: string;
  readonly legalName: string;
  readonly tradeName: string;
  readonly country: string;
  readonly declaredEuid?: string;
  readonly isPublicSectorBody: boolean;
  readonly owner: PersonId;
  readonly createdAt: Date;
}

export interface SignInAttempt {
  readonly id: SignInAttemptId;
  readonly purpose: SignInPurpose;
  readonly invitationId?: InvitationId;
  readonly presentationId: string;
  readonly subject?: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly completedAt?: Date;
}

/** The sandbox register's identifier scheme, as stored in the platform organisation. */
export const SANDBOX_IDENTIFIER_SCHEME_URI = "urn:edtp:sandbox:identifier";

const toPerson = (row: typeof sandboxPeople.$inferSelect): Person => ({
  id: asId<"SandboxPersonId">(row.id),
  subject: row.subject,
  displayName: row.displayName,
  createdAt: row.createdAt,
  lastSignInAt: row.lastSignInAt,
});

const toOrganisation = (
  row: typeof sandboxOrganisations.$inferSelect,
): SandboxOrganisation => ({
  tenantId: asId<"TenantId">(row.tenantId),
  localIdentifier: row.localIdentifier,
  country: row.country,
  ...(row.declaredEuid ? { declaredEuid: row.declaredEuid } : {}),
  verified: false,
  status: row.status as SandboxOrganisation["status"],
  createdAt: row.createdAt,
});

export class SandboxRepository {
  constructor(private readonly db: Database) {}

  // --- people ----------------------------------------------------------------------------------

  async findPersonBySubject(subject: string): Promise<Person | undefined> {
    const [row] = await this.db
      .select()
      .from(sandboxPeople)
      .where(eq(sandboxPeople.subject, subject));
    return row ? toPerson(row) : undefined;
  }

  async findPerson(id: PersonId): Promise<Person | undefined> {
    const [row] = await this.db.select().from(sandboxPeople).where(eq(sandboxPeople.id, id));
    return row ? toPerson(row) : undefined;
  }

  async createPerson(person: Person): Promise<void> {
    await this.db.insert(sandboxPeople).values(person);
  }

  async recordSignIn(id: PersonId, at: Date): Promise<void> {
    await this.db
      .update(sandboxPeople)
      .set({ lastSignInAt: at })
      .where(eq(sandboxPeople.id, id));
  }

  // --- organisations ---------------------------------------------------------------------------

  /**
   * One transaction: the platform tenant, its organisation, the sandbox record with the next
   * `SB:<CC>-<n>` identifier, and the owner's membership. A failure leaves nothing behind.
   */
  async createOrganisation(input: NewSandboxOrganisation): Promise<SandboxOrganisation> {
    return this.db.transaction(async (tx) => {
      const [numbered] = await tx
        .execute<{ n: string }>(sql`SELECT nextval('sandbox_organisation_number_seq') AS n`)
        .then((r) => r.rows);
      const number = Number(numbered?.n);
      const localIdentifier = formatSandboxIdentifier(input.country, number);
      await tx
        .insert(tenants)
        .values({ id: input.tenantId, name: input.tradeName, createdAt: input.createdAt });
      await tx.insert(organisations).values({
        id: input.organisationId,
        tenantId: input.tenantId,
        legalName: input.legalName,
        officialIdentifiers: [
          { scheme: SANDBOX_IDENTIFIER_SCHEME_URI, value: localIdentifier },
          ...(input.declaredEuid
            ? [
                {
                  scheme: "http://data.europa.eu/eudi/id/EUID",
                  value: input.declaredEuid,
                  declared: true,
                },
              ]
            : []),
        ],
        memberState: input.country,
        isPublicSectorBody: input.isPublicSectorBody,
        createdAt: input.createdAt,
      });
      const [row] = await tx
        .insert(sandboxOrganisations)
        .values({
          tenantId: input.tenantId,
          organisationId: input.organisationId,
          number,
          localIdentifier,
          country: input.country,
          declaredEuid: input.declaredEuid ?? null,
          status: "ACTIVE",
          createdAt: input.createdAt,
        })
        .returning();
      await tx.insert(sandboxMemberships).values({
        tenantId: input.tenantId,
        personId: input.owner,
        role: "owner",
        createdAt: input.createdAt,
      });
      if (!row) throw new Error("sandbox organisation was not created");
      return toOrganisation(row);
    });
  }

  /** For the operator: by the `SB:` identifier every certificate carries. */
  async findOrganisationByLocalIdentifier(
    localIdentifier: string,
  ): Promise<SandboxOrganisation | undefined> {
    const [row] = await this.db
      .select()
      .from(sandboxOrganisations)
      .where(eq(sandboxOrganisations.localIdentifier, localIdentifier));
    return row ? toOrganisation(row) : undefined;
  }

  /** For the operator: every organisation, oldest first. */
  async organisations(): Promise<SandboxOrganisation[]> {
    const rows = await this.db
      .select()
      .from(sandboxOrganisations)
      .orderBy(sandboxOrganisations.number);
    return rows.map(toOrganisation);
  }

  /** Once: true only for the call that moved the organisation from ACTIVE to SUSPENDED. */
  async suspendOrganisation(tenantId: TenantId, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(sandboxOrganisations)
      .set({ status: "SUSPENDED", suspendedAt: at })
      .where(
        and(
          eq(sandboxOrganisations.tenantId, tenantId),
          eq(sandboxOrganisations.status, "ACTIVE"),
        ),
      )
      .returning({ tenantId: sandboxOrganisations.tenantId });
    return rows.length === 1;
  }

  async findOrganisation(tenantId: TenantId): Promise<SandboxOrganisation | undefined> {
    const [row] = await this.db
      .select()
      .from(sandboxOrganisations)
      .where(eq(sandboxOrganisations.tenantId, tenantId));
    return row ? toOrganisation(row) : undefined;
  }

  // --- memberships -----------------------------------------------------------------------------

  async membershipsOfPerson(personId: PersonId): Promise<Membership[]> {
    const rows = await this.db
      .select()
      .from(sandboxMemberships)
      .where(eq(sandboxMemberships.personId, personId));
    return rows.map((r) => ({
      tenantId: asId<"TenantId">(r.tenantId),
      personId: asId<"SandboxPersonId">(r.personId),
      role: r.role as Role,
      createdAt: r.createdAt,
    }));
  }

  async membersOf(tenantId: TenantId): Promise<(Membership & { displayName: string })[]> {
    const rows = await this.db
      .select({ m: sandboxMemberships, displayName: sandboxPeople.displayName })
      .from(sandboxMemberships)
      .innerJoin(sandboxPeople, eq(sandboxPeople.id, sandboxMemberships.personId))
      .where(eq(sandboxMemberships.tenantId, tenantId));
    return rows.map((r) => ({
      tenantId: asId<"TenantId">(r.m.tenantId),
      personId: asId<"SandboxPersonId">(r.m.personId),
      role: r.m.role as Role,
      createdAt: r.m.createdAt,
      displayName: r.displayName,
    }));
  }

  async removeMember(tenantId: TenantId, personId: PersonId): Promise<void> {
    await this.db
      .delete(sandboxMemberships)
      .where(
        and(
          eq(sandboxMemberships.tenantId, tenantId),
          eq(sandboxMemberships.personId, personId),
        ),
      );
  }

  // --- invitations -----------------------------------------------------------------------------

  async createInvitation(invitation: Invitation, token: string): Promise<void> {
    await this.db.insert(sandboxInvitations).values({
      id: invitation.id,
      tenantId: invitation.tenantId,
      tokenHash: hashSandboxToken(token),
      role: invitation.role,
      createdBy: invitation.createdBy,
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
    });
  }

  async findInvitationByToken(token: string): Promise<Invitation | undefined> {
    const [row] = await this.db
      .select()
      .from(sandboxInvitations)
      .where(eq(sandboxInvitations.tokenHash, hashSandboxToken(token)));
    if (!row) return undefined;
    return {
      id: asId<"SandboxInvitationId">(row.id),
      tenantId: asId<"TenantId">(row.tenantId),
      role: row.role as Role,
      createdBy: asId<"SandboxPersonId">(row.createdBy),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      ...(row.acceptedAt ? { acceptedAt: row.acceptedAt } : {}),
      ...(row.acceptedBy ? { acceptedBy: asId<"SandboxPersonId">(row.acceptedBy) } : {}),
    };
  }

  /**
   * Accept once, atomically: the update matches only an unused, unexpired invitation, so two
   * browsers racing on one link cannot both join. Returns false when it did not match.
   */
  async acceptInvitation(id: InvitationId, personId: PersonId, at: Date): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [accepted] = await tx
        .update(sandboxInvitations)
        .set({ acceptedAt: at, acceptedBy: personId })
        .where(
          and(
            eq(sandboxInvitations.id, id),
            isNull(sandboxInvitations.acceptedAt),
            gt(sandboxInvitations.expiresAt, at),
          ),
        )
        .returning();
      if (!accepted) return false;
      await tx
        .insert(sandboxMemberships)
        .values({ tenantId: accepted.tenantId, personId, role: accepted.role, createdAt: at })
        .onConflictDoNothing();
      return true;
    });
  }

  // --- sessions --------------------------------------------------------------------------------

  async createSession(token: string, personId: PersonId, at: Date): Promise<void> {
    await this.db
      .insert(sandboxSessions)
      .values({ tokenHash: hashSandboxToken(token), personId, createdAt: at, lastSeenAt: at });
  }

  async findSession(token: string): Promise<Session | undefined> {
    const [row] = await this.db
      .select()
      .from(sandboxSessions)
      .where(eq(sandboxSessions.tokenHash, hashSandboxToken(token)));
    if (!row) return undefined;
    return {
      personId: asId<"SandboxPersonId">(row.personId),
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      ...(row.endedAt ? { endedAt: row.endedAt } : {}),
    };
  }

  async touchSession(token: string, at: Date): Promise<void> {
    await this.db
      .update(sandboxSessions)
      .set({ lastSeenAt: at })
      .where(eq(sandboxSessions.tokenHash, hashSandboxToken(token)));
  }

  async endSession(token: string, at: Date): Promise<void> {
    await this.db
      .update(sandboxSessions)
      .set({ endedAt: at })
      .where(
        and(
          eq(sandboxSessions.tokenHash, hashSandboxToken(token)),
          isNull(sandboxSessions.endedAt),
        ),
      );
  }

  // --- sign-in attempts ------------------------------------------------------------------------

  async createSignInAttempt(attempt: SignInAttempt, bindingToken: string): Promise<void> {
    await this.db.insert(sandboxSignInAttempts).values({
      id: attempt.id,
      bindingHash: hashSandboxToken(bindingToken),
      purpose: attempt.purpose,
      invitationId: attempt.invitationId ?? null,
      presentationId: attempt.presentationId,
      createdAt: attempt.createdAt,
      expiresAt: attempt.expiresAt,
    });
  }

  /** The attempt, only for the browser holding its binding token. */
  async findSignInAttempt(
    id: SignInAttemptId,
    bindingToken: string,
  ): Promise<SignInAttempt | undefined> {
    const [row] = await this.db
      .select()
      .from(sandboxSignInAttempts)
      .where(
        and(
          eq(sandboxSignInAttempts.id, id),
          eq(sandboxSignInAttempts.bindingHash, hashSandboxToken(bindingToken)),
        ),
      );
    if (!row) return undefined;
    return {
      id: asId<"SandboxSignInAttemptId">(row.id),
      purpose: row.purpose as SignInPurpose,
      ...(row.invitationId
        ? { invitationId: asId<"SandboxInvitationId">(row.invitationId) }
        : {}),
      presentationId: row.presentationId,
      ...(row.subject ? { subject: row.subject } : {}),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    };
  }

  /**
   * Hold the subject of a verified person who is not yet known, until the profile step. Only on an
   * open attempt, and only once.
   */
  async holdSubject(id: SignInAttemptId, subject: string, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(sandboxSignInAttempts)
      .set({ subject })
      .where(
        and(
          eq(sandboxSignInAttempts.id, id),
          isNull(sandboxSignInAttempts.completedAt),
          isNull(sandboxSignInAttempts.subject),
          gt(sandboxSignInAttempts.expiresAt, at),
        ),
      )
      .returning({ id: sandboxSignInAttempts.id });
    return rows.length === 1;
  }

  /** Complete once, atomically. Returns false if it was already completed or has expired. */
  async completeSignInAttempt(id: SignInAttemptId, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(sandboxSignInAttempts)
      .set({ completedAt: at })
      .where(
        and(
          eq(sandboxSignInAttempts.id, id),
          isNull(sandboxSignInAttempts.completedAt),
          gt(sandboxSignInAttempts.expiresAt, at),
        ),
      )
      .returning({ id: sandboxSignInAttempts.id });
    return rows.length === 1;
  }

  // --- API keys --------------------------------------------------------------------------------

  /** The organisation's keys, without their hashes. */
  async apiKeysOf(tenantId: TenantId) {
    return this.db
      .select({
        id: apiKeys.id,
        keyPrefix: apiKeys.keyPrefix,
        label: apiKeys.label,
        createdAt: apiKeys.createdAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.tenantId, tenantId));
  }

  async revokeApiKey(tenantId: TenantId, id: string, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(apiKeys)
      .set({ revokedAt: at })
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    return rows.length === 1;
  }
}
