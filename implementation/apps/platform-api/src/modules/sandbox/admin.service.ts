import type { SandboxAdminRepository, SandboxRepository } from "@edtp/persistence";
import { QUOTA_WINDOW_MS, SANDBOX_QUOTAS } from "@edtp/sandbox-domain";
import { asId, type Clock, PlatformError, type TenantId } from "@edtp/shared";
import type { AuditService } from "../audit/audit.service.js";
import type { SandboxCertificateService } from "./certificates.service.js";
import type { SandboxService, SignedInContext } from "./sandbox.service.js";

/**
 * The operator's section (ADR 0019): read-only views across every organisation, and three actions
 * the specification gives the operator — suspend an organisation, withdraw an invitation, end a
 * person's sessions.
 *
 * Every method first checks that the signed-in person is an operator, and answers anyone else as
 * `not_found`, so the section does not show that it exists. The session itself has already been
 * bound to the Access identity by `SandboxAccessGuard`.
 *
 * Audit records name the operator by person id (`sandbox-operator:<id>`), never by address
 * (ADR 0018 Decision 5).
 */
export class SandboxAdminService {
  constructor(
    private readonly sandbox: SandboxService,
    private readonly admin: SandboxAdminRepository,
    private readonly sandboxPeople: SandboxRepository,
    private readonly certificates: SandboxCertificateService | undefined,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly operatorTenantId: TenantId,
  ) {}

  private operator(context: SignedInContext): string {
    if (!this.sandbox.isOperator(context)) throw PlatformError.notFound("Route");
    return `sandbox-operator:${context.person.id}`;
  }

  private window() {
    const now = this.clock.now();
    return { now, since: new Date(now.getTime() - QUOTA_WINDOW_MS) };
  }

  async overview(context: SignedInContext) {
    this.operator(context);
    const { now, since } = this.window();
    return { ...(await this.admin.overview(now, since)), quotas: SANDBOX_QUOTAS };
  }

  async organisations(context: SignedInContext) {
    this.operator(context);
    return { organisations: await this.admin.organisations(), quotas: SANDBOX_QUOTAS };
  }

  async organisation(context: SignedInContext, tenantId: string) {
    this.operator(context);
    const organisation = await this.admin.organisation(tenantId);
    if (!organisation) throw PlatformError.notFound("Organisation");
    const { now, since } = this.window();
    const [members, services, certificates, invitations] = await Promise.all([
      this.sandboxPeople.membersOf(asId<"TenantId">(tenantId)),
      this.admin.services(tenantId, since),
      this.admin.certificates(tenantId),
      this.admin.invitations(now, tenantId),
    ]);
    return {
      organisation,
      members: members.map((m) => ({
        personId: m.personId,
        displayName: m.displayName,
        email: m.email,
        role: m.role,
      })),
      services,
      certificates,
      invitations,
      quotas: SANDBOX_QUOTAS,
    };
  }

  async people(context: SignedInContext) {
    this.operator(context);
    return { people: await this.admin.people() };
  }

  async invitations(context: SignedInContext) {
    this.operator(context);
    return { invitations: await this.admin.invitations(this.clock.now()) };
  }

  async auditTrail(context: SignedInContext, tenantId?: string) {
    this.operator(context);
    return { records: await this.admin.audit(200, tenantId) };
  }

  // --- actions -------------------------------------------------------------------------------

  /** Specification J9: every certificate revoked, nothing more created; final in v1. */
  async suspend(context: SignedInContext, tenantId: string, reason: string) {
    const actor = this.operator(context);
    const organisation = await this.admin.organisation(tenantId);
    if (!organisation) throw PlatformError.notFound("Organisation");
    if (!this.certificates) {
      throw PlatformError.conflict(
        "sandbox_pki_not_configured",
        "Suspension needs the sandbox's certificate service.",
      );
    }
    return this.certificates.suspendOrganisation(organisation.localIdentifier, reason, actor);
  }

  async revokeInvitation(context: SignedInContext, invitationId: string) {
    const actor = this.operator(context);
    const tenantId = await this.admin.expireInvitation(invitationId, this.clock.now());
    if (!tenantId) throw PlatformError.notFound("Invitation");
    await this.audit.record({
      tenantId: asId<"TenantId">(tenantId),
      actor,
      action: "sandbox.invitation.revoked",
      subjectType: "sandbox_invitation",
      subjectId: invitationId,
    });
  }

  async endSessions(context: SignedInContext, personId: string) {
    const actor = this.operator(context);
    const person = await this.sandboxPeople.findPerson(asId<"SandboxPersonId">(personId));
    if (!person) throw PlatformError.notFound("Person");
    const ended = await this.admin.endSessionsOf(personId, this.clock.now());
    await this.audit.record({
      tenantId: this.operatorTenantId,
      actor,
      action: "sandbox.person.sessions_ended",
      subjectType: "sandbox_person",
      subjectId: personId,
      detail: { ended },
    });
    return { ended };
  }
}
