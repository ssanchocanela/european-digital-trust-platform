import type { SandboxRepository } from "@edtp/persistence";
import { canManage, type PersonId } from "@edtp/sandbox-domain";
import { asId, type Clock, PlatformError, type TenantId } from "@edtp/shared";
import type { AuditService } from "../audit/audit.service.js";
import type { SandboxCertificateService } from "./certificates.service.js";
import type { SandboxService, SignedInContext } from "./sandbox.service.js";

/**
 * Erasure of a person (ADR 0021): by themselves, or by the operator on a request received another
 * way. One transaction removes the person and everything that is theirs; the audit trail keeps only
 * their id, which then points at nothing.
 *
 * An organisation is never left without an owner (ADR 0015 Decision 7, ADR 0021 §3):
 * - the last owner of an organisation with other members is refused, unless the operator overrides;
 * - an organisation whose only member is erased, or whose last owner the operator erases over the
 *   refusal, is suspended — certificates revoked, Wallet Provider anchors off the list — and kept.
 */
export type ErasureEffect = "kept" | "suspended" | "blocked";

export interface ErasurePlan {
  readonly organisations: readonly {
    readonly tenantId: string;
    readonly localIdentifier: string;
    readonly role: string;
    readonly members: number;
    readonly effect: ErasureEffect;
  }[];
  /** True when nothing blocks the erasure (for the operator: when overriding). */
  readonly allowed: boolean;
}

/** How long backups keep what erasure removes, stated to the person (ADR 0021 §5). */
export const BACKUP_RETENTION = { dumpsDays: 14, serverImagesDays: 7 } as const;

export class SandboxErasureService {
  constructor(
    private readonly sandbox: SandboxService,
    private readonly people: SandboxRepository,
    private readonly certificates: SandboxCertificateService | undefined,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly operatorTenantId: TenantId,
  ) {}

  private async plan(personId: PersonId, override: boolean): Promise<ErasurePlan> {
    const memberships = await this.people.membershipsOfPerson(personId);
    const organisations = [];
    for (const m of memberships) {
      const members = await this.people.membersOf(m.tenantId);
      const owners = members.filter((x) => x.role === "owner");
      const lastOwner = canManage(m) && owners.length === 1;
      const effect: ErasureEffect =
        members.length === 1
          ? "suspended"
          : lastOwner
            ? override
              ? "suspended"
              : "blocked"
            : "kept";
      const org = await this.people.findOrganisation(m.tenantId);
      organisations.push({
        tenantId: m.tenantId,
        localIdentifier: org?.localIdentifier ?? "",
        role: m.role,
        members: members.length,
        effect,
      });
    }
    return { organisations, allowed: organisations.every((o) => o.effect !== "blocked") };
  }

  private async execute(personId: PersonId, plan: ErasurePlan, actor: string, reason: string) {
    // Suspend first: once the person is gone, their memberships — and so the plan — go with them.
    for (const o of plan.organisations.filter((x) => x.effect === "suspended")) {
      if (this.certificates) {
        await this.certificates.suspendOrganisation(o.localIdentifier, reason, actor);
      } else {
        await this.people.suspendOrganisation(asId<"TenantId">(o.tenantId), this.clock.now());
      }
    }
    if (!(await this.people.erasePerson(personId))) throw PlatformError.notFound("Person");
    await this.audit.record({
      tenantId: this.operatorTenantId,
      actor,
      action: "sandbox.person.erased",
      subjectType: "sandbox_person",
      subjectId: personId,
      detail: {
        suspendedOrganisations: plan.organisations.filter((o) => o.effect === "suspended")
          .length,
        ...(actor !== "sandbox" ? { reason: reason.slice(0, 200) } : {}),
      },
    });
    return {
      erased: true,
      suspended: plan.organisations
        .filter((o) => o.effect === "suspended")
        .map((o) => o.localIdentifier),
    };
  }

  // --- the person themselves ------------------------------------------------------------------

  async previewSelf(context: SignedInContext) {
    return { ...(await this.plan(context.person.id, false)), backups: BACKUP_RETENTION };
  }

  /** The person confirms by typing their own address, which must match the one Access verified. */
  async eraseSelf(context: SignedInContext, confirmEmail: string) {
    if (confirmEmail.trim().toLowerCase() !== context.person.email) {
      throw PlatformError.validation(
        "erasure_confirmation_mismatch",
        "Type your own e-mail address to confirm.",
      );
    }
    const plan = await this.plan(context.person.id, false);
    if (!plan.allowed) {
      throw PlatformError.conflict(
        "sandbox_last_owner",
        "You are the last owner of an organisation with other members. Make another member an owner first.",
      );
    }
    return this.execute(context.person.id, plan, "sandbox", "erased at the person's request");
  }

  // --- the operator -----------------------------------------------------------------------------

  private operator(context: SignedInContext): string {
    if (!this.sandbox.isOperator(context)) throw PlatformError.notFound("Route");
    return `sandbox-operator:${context.person.id}`;
  }

  async previewByOperator(context: SignedInContext, personId: string, override: boolean) {
    this.operator(context);
    const person = await this.people.findPerson(asId<"SandboxPersonId">(personId));
    if (!person) throw PlatformError.notFound("Person");
    return {
      displayName: person.displayName,
      email: person.email,
      ...(await this.plan(person.id, override)),
      backups: BACKUP_RETENTION,
    };
  }

  async eraseByOperator(
    context: SignedInContext,
    personId: string,
    reason: string,
    override: boolean,
  ) {
    const actor = this.operator(context);
    const person = await this.people.findPerson(asId<"SandboxPersonId">(personId));
    if (!person) throw PlatformError.notFound("Person");
    if (person.id === context.person.id) {
      throw PlatformError.conflict(
        "erasure_of_self_by_operator",
        "Erase your own account from your dashboard, not from the operator's section.",
      );
    }
    const plan = await this.plan(person.id, override);
    if (!plan.allowed) {
      throw PlatformError.conflict(
        "sandbox_last_owner",
        "This person is the last owner of an organisation with other members. Override to suspend it.",
      );
    }
    return this.execute(person.id, plan, actor, reason);
  }
}
