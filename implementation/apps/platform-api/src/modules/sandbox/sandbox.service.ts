import { TERMINAL_STATES } from "@edtp/domain";
import type { ApiKeyRepository, PolicyRepository, SandboxRepository } from "@edtp/persistence";
import {
  canManage,
  checkInvitation,
  checkRemoval,
  INVITATION_TTL_MS,
  isSessionLive,
  type Membership,
  normaliseDisplayName,
  type Person,
  type PersonId,
  type Role,
  type SandboxOrganisation,
  SIGN_IN_ATTEMPT_TTL_MS,
  type SignInAttemptId,
  type SignInPurpose,
  sharedTrustSources,
} from "@edtp/sandbox-domain";
import {
  asId,
  type Clock,
  type CorrelationId,
  newOpaqueToken,
  newUuid,
  PlatformError,
  type TenantId,
} from "@edtp/shared";
import type { Logger } from "../../logging/logger.js";
import type { AuditService } from "../audit/audit.service.js";
import type { HostedFormReturns } from "../issuances/hosted-form-returns.js";
import type { PresentationService } from "../presentations/presentation.service.js";

/**
 * The sandbox's people: sign-up and sign-in by PID, organisations, members, invitations and API keys
 * (ADR 0015).
 *
 * Sign-in is a presentation to the sandbox operator's own sign-in verifier, under one policy whose
 * result is a single `PseudonymousSubject`. This service never sees a PID value: it reads the
 * subject from the presentation's result and nothing else.
 */
export interface SandboxSettings {
  readonly operatorTenantId: TenantId;
  readonly signInPolicyId: string;
  /** Trust anchor sources participants' PID Providers can be placed on. Never trusted for sign-in. */
  readonly participantTrustSources: readonly string[];
  /** The portal origin the wallet returns to after a same-device presentation. */
  readonly portalPublicUrl: string;
}

/** The result claim the sign-in policy's `PseudonymousSubject` derivation must write. */
export const SIGN_IN_SUBJECT_CLAIM = "subject";

export type SignInCompletion =
  | { readonly outcome: "pending" }
  | { readonly outcome: "failed"; readonly failureCode: string }
  | { readonly outcome: "signed_in"; readonly sessionToken: string }
  | { readonly outcome: "needs_profile" }
  | { readonly outcome: "unknown_person" };

export interface OrganisationProfile {
  readonly legalName: string;
  readonly tradeName: string;
  readonly country: string;
  readonly declaredEuid?: string;
  readonly isPublicSectorBody: boolean;
}

export interface SignedInContext {
  readonly person: Person;
  readonly memberships: readonly Membership[];
}

export class SandboxService {
  constructor(
    private readonly settings: SandboxSettings,
    private readonly repository: SandboxRepository,
    private readonly policies: PolicyRepository,
    private readonly apiKeys: ApiKeyRepository,
    private readonly presentations: PresentationService,
    private readonly returns: HostedFormReturns,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  // --- sign-in ---------------------------------------------------------------------------------

  /**
   * ADR 0015 Decision 2, checked on every start rather than once at boot, so a policy republished
   * with a participant-reachable anchor is refused at its first use: the sign-in verifier must never
   * trust a source a participant can place.
   */
  private async assertSignInTrustIsSeparate(): Promise<void> {
    const versions = await this.policies.listVersions(
      this.settings.operatorTenantId,
      asId<"PresentationPolicyId">(this.settings.signInPolicyId),
    );
    const published = versions.filter((v) => v.status === "PUBLISHED").at(-1);
    if (!published) {
      throw PlatformError.conflict(
        "sandbox_sign_in_not_configured",
        "Sign-in is not configured.",
      );
    }
    const refs = published.trustPolicy.anchorSources.map((s) => s.ref);
    const shared = sharedTrustSources(refs, this.settings.participantTrustSources);
    if (refs.length === 0 || shared.length > 0) {
      this.logger.error("sandbox sign-in refused: its trust anchors are not separate", {
        sharedSourceCount: shared.length,
        sourceCount: refs.length,
      });
      throw PlatformError.conflict(
        "sandbox_sign_in_misconfigured",
        "Sign-in is unavailable: its trust configuration is not separate from the participants'.",
      );
    }
  }

  async startSignIn(input: {
    readonly purpose: SignInPurpose;
    readonly invitationToken?: string;
    readonly interactionType: "SAME_DEVICE" | "QR";
    readonly correlationId: CorrelationId;
  }) {
    await this.assertSignInTrustIsSeparate();
    let invitationId: string | undefined;
    if (input.purpose === "accept_invitation") {
      const invitation = input.invitationToken
        ? await this.repository.findInvitationByToken(input.invitationToken)
        : undefined;
      if (!invitation) throw PlatformError.notFound("Invitation");
      const refusal = checkInvitation(invitation, this.clock.now());
      if (refusal)
        throw PlatformError.conflict(`invitation_${refusal}`, `The invitation is ${refusal}.`);
      invitationId = invitation.id;
    }
    const view = await this.presentations.create({
      tenantId: this.settings.operatorTenantId,
      policyId: asId<"PresentationPolicyId">(this.settings.signInPolicyId),
      businessReference: `sandbox-${input.purpose}`,
      interactionType: input.interactionType,
      correlationId: input.correlationId,
    });
    const now = this.clock.now();
    const attemptId = asId<"SandboxSignInAttemptId">(newUuid());
    const bindingToken = newOpaqueToken(32);
    const expiresAt = new Date(now.getTime() + SIGN_IN_ATTEMPT_TTL_MS);
    await this.repository.createSignInAttempt(
      {
        id: attemptId,
        purpose: input.purpose,
        ...(invitationId ? { invitationId: asId<"SandboxInvitationId">(invitationId) } : {}),
        presentationId: view.presentationId,
        createdAt: now,
        expiresAt,
      },
      bindingToken,
    );
    if (input.interactionType === "SAME_DEVICE") {
      const back = new URL("sign-in/return", withSlash(this.settings.portalPublicUrl));
      back.searchParams.set("attempt", attemptId);
      this.returns.remember(view.presentationId, back.toString(), view.expiresAt);
    }
    return {
      attemptId,
      bindingToken,
      walletUri: view.interaction?.uri,
      interactionType: input.interactionType,
      expiresAt: view.expiresAt < expiresAt ? view.expiresAt : expiresAt,
    };
  }

  private async openAttempt(attemptId: string, bindingToken: string) {
    const attempt = await this.repository.findSignInAttempt(
      asId<"SandboxSignInAttemptId">(attemptId),
      bindingToken,
    );
    // Unknown and not-this-browser look the same: a binding mismatch reveals nothing.
    if (!attempt) throw PlatformError.notFound("Sign-in attempt");
    if (attempt.completedAt) {
      throw PlatformError.conflict(
        "sign_in_attempt_used",
        "This sign-in has already been used.",
      );
    }
    if (attempt.expiresAt.getTime() <= this.clock.now().getTime()) {
      throw PlatformError.conflict("sign_in_attempt_expired", "This sign-in has expired.");
    }
    return attempt;
  }

  /**
   * Poll an attempt. When its presentation has verified, the subject decides: a known person is
   * signed in (or joins the inviting organisation); an unknown one is asked for a profile, and the
   * subject is held on the attempt until then.
   */
  async completeSignIn(
    attemptId: string,
    bindingToken: string,
    correlationId: CorrelationId,
  ): Promise<SignInCompletion> {
    const attempt = await this.openAttempt(attemptId, bindingToken);
    if (attempt.subject) return { outcome: "needs_profile" };
    const view = await this.presentations.get(
      this.settings.operatorTenantId,
      asId<"PresentationId">(attempt.presentationId),
      correlationId,
    );
    if (view.status !== "VERIFIED") {
      if ((TERMINAL_STATES as readonly string[]).includes(view.status) || view.failureCode) {
        return {
          outcome: "failed",
          failureCode: view.failureCode ?? view.status.toLowerCase(),
        };
      }
      return { outcome: "pending" };
    }
    const subject = view.result?.claims[SIGN_IN_SUBJECT_CLAIM];
    if (typeof subject !== "string" || subject.length < 20) {
      return { outcome: "failed", failureCode: "sign_in_subject_missing" };
    }
    const now = this.clock.now();
    const person = await this.repository.findPersonBySubject(subject);
    if (!person) {
      if (attempt.purpose === "sign_in") {
        // Complete it, so a verified presentation cannot be replayed into a later sign-up.
        await this.repository.completeSignInAttempt(attempt.id, now);
        return { outcome: "unknown_person" };
      }
      await this.repository.holdSubject(attempt.id, subject, now);
      return { outcome: "needs_profile" };
    }
    if (!(await this.repository.completeSignInAttempt(attempt.id, now))) {
      throw PlatformError.conflict(
        "sign_in_attempt_used",
        "This sign-in has already been used.",
      );
    }
    if (attempt.purpose === "accept_invitation" && attempt.invitationId) {
      await this.join(attempt.invitationId, person.id, now);
    }
    return { outcome: "signed_in", sessionToken: await this.openSession(person.id, now) };
  }

  /**
   * The profile step for a person the presentation verified but the sandbox does not know: their
   * display name, and — for a sign-up — the organisation they declare. One person, one session.
   */
  async completeProfile(input: {
    readonly attemptId: string;
    readonly bindingToken: string;
    readonly displayName: string;
    readonly organisation?: OrganisationProfile;
  }): Promise<{ readonly sessionToken: string; readonly organisation?: SandboxOrganisation }> {
    const attempt = await this.openAttempt(input.attemptId, input.bindingToken);
    if (!attempt.subject) {
      throw PlatformError.conflict(
        "sign_in_profile_not_expected",
        "No profile is expected for this sign-in.",
      );
    }
    const displayName = normaliseDisplayName(input.displayName);
    if (!displayName) {
      throw PlatformError.validation("invalid_display_name", "Invalid display name.", [
        {
          path: "displayName",
          code: "invalid",
          message: "Must be 1 to 80 characters, without control characters.",
        },
      ]);
    }
    if (attempt.purpose === "sign_up" && !input.organisation) {
      throw PlatformError.validation(
        "organisation_required",
        "An organisation is required to sign up.",
        [{ path: "organisation", code: "required", message: "Required to sign up." }],
      );
    }
    const now = this.clock.now();
    if (!(await this.repository.completeSignInAttempt(attempt.id, now))) {
      throw PlatformError.conflict(
        "sign_in_attempt_used",
        "This sign-in has already been used.",
      );
    }
    const person: Person = {
      id: asId<"SandboxPersonId">(newUuid()),
      subject: attempt.subject,
      displayName,
      createdAt: now,
      lastSignInAt: now,
    };
    await this.repository.createPerson(person);
    await this.audit.record({
      tenantId: this.settings.operatorTenantId,
      actor: "sandbox",
      action: "sandbox.person.created",
      subjectType: "sandbox_person",
      subjectId: person.id,
    });
    let organisation: SandboxOrganisation | undefined;
    if (attempt.purpose === "sign_up" && input.organisation) {
      organisation = await this.createOrganisation(person.id, input.organisation, now);
    }
    if (attempt.purpose === "accept_invitation" && attempt.invitationId) {
      await this.join(attempt.invitationId, person.id, now);
    }
    return {
      sessionToken: await this.openSession(person.id, now),
      ...(organisation ? { organisation } : {}),
    };
  }

  private async openSession(personId: PersonId, now: Date): Promise<string> {
    const token = newOpaqueToken(32);
    await this.repository.createSession(token, personId, now);
    await this.repository.recordSignIn(personId, now);
    await this.audit.record({
      tenantId: this.settings.operatorTenantId,
      actor: "sandbox",
      action: "sandbox.sign_in",
      subjectType: "sandbox_person",
      subjectId: personId,
    });
    return token;
  }

  private async join(invitationId: string, personId: PersonId, now: Date): Promise<void> {
    const joined = await this.repository.acceptInvitation(
      asId<"SandboxInvitationId">(invitationId),
      personId,
      now,
    );
    if (!joined)
      throw PlatformError.conflict("invitation_used", "The invitation is no longer valid.");
  }

  // --- sessions --------------------------------------------------------------------------------

  /** The person behind a session token, or an authentication error. Touches the session. */
  async authenticate(sessionToken: string): Promise<SignedInContext> {
    const session = await this.repository.findSession(sessionToken);
    const now = this.clock.now();
    if (!session || !isSessionLive(session, now)) throw PlatformError.unauthenticated();
    const person = await this.repository.findPerson(session.personId);
    if (!person) throw PlatformError.unauthenticated();
    await this.repository.touchSession(sessionToken, now);
    return { person, memberships: await this.repository.membershipsOfPerson(person.id) };
  }

  async signOut(sessionToken: string): Promise<void> {
    await this.repository.endSession(sessionToken, this.clock.now());
  }

  // --- organisations ---------------------------------------------------------------------------

  private async createOrganisation(owner: PersonId, profile: OrganisationProfile, now: Date) {
    const tenantId = asId<"TenantId">(newUuid());
    const organisation = await this.repository.createOrganisation({
      tenantId,
      organisationId: newUuid(),
      legalName: profile.legalName,
      tradeName: profile.tradeName,
      country: profile.country,
      ...(profile.declaredEuid ? { declaredEuid: profile.declaredEuid } : {}),
      isPublicSectorBody: profile.isPublicSectorBody,
      owner,
      createdAt: now,
    });
    await this.audit.record({
      tenantId,
      actor: "sandbox",
      action: "sandbox.organisation.created",
      subjectType: "sandbox_organisation",
      subjectId: tenantId,
    });
    return organisation;
  }

  /** A signed-in person creates another organisation, and owns it. */
  async addOrganisation(context: SignedInContext, profile: OrganisationProfile) {
    return this.createOrganisation(context.person.id, profile, this.clock.now());
  }

  /**
   * The membership that authorises `context` on `tenantId`. The tenant comes from a path, so it is
   * only ever **checked** against the person's memberships (CLAUDE.md §9); another organisation's
   * id is answered as not found.
   */
  membershipIn(context: SignedInContext, tenantId: string): Membership {
    const membership = context.memberships.find((m) => m.tenantId === tenantId);
    if (!membership) throw PlatformError.notFound("Organisation");
    return membership;
  }

  private ownerIn(context: SignedInContext, tenantId: string): Membership {
    const membership = this.membershipIn(context, tenantId);
    if (!canManage(membership)) {
      throw PlatformError.forbidden("sandbox_owner_required", "Only an owner can do this.");
    }
    return membership;
  }

  async organisation(context: SignedInContext, tenantId: string) {
    const membership = this.membershipIn(context, tenantId);
    const organisation = await this.repository.findOrganisation(membership.tenantId);
    if (!organisation) throw PlatformError.notFound("Organisation");
    return { organisation, role: membership.role };
  }

  async members(context: SignedInContext, tenantId: string) {
    const membership = this.membershipIn(context, tenantId);
    return this.repository.membersOf(membership.tenantId);
  }

  async invite(context: SignedInContext, tenantId: string, role: Role) {
    const membership = this.ownerIn(context, tenantId);
    const now = this.clock.now();
    const token = newOpaqueToken(32);
    const invitation = {
      id: asId<"SandboxInvitationId">(newUuid()),
      tenantId: membership.tenantId,
      role,
      createdBy: context.person.id,
      createdAt: now,
      expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
    };
    await this.repository.createInvitation(invitation, token);
    await this.audit.record({
      tenantId: membership.tenantId,
      actor: "sandbox",
      action: "sandbox.invitation.created",
      subjectType: "sandbox_invitation",
      subjectId: invitation.id,
    });
    // The token is returned once; only its hash is kept.
    return { invitationToken: token, role, expiresAt: invitation.expiresAt };
  }

  async removeMember(context: SignedInContext, tenantId: string, target: string) {
    const membership = this.membershipIn(context, tenantId);
    const members = await this.repository.membersOf(membership.tenantId);
    const refusal = checkRemoval(members, context.person.id, asId<"SandboxPersonId">(target));
    if (refusal === "not_a_member") throw PlatformError.notFound("Member");
    if (refusal === "not_an_owner") {
      throw PlatformError.forbidden(
        "sandbox_owner_required",
        "Only an owner can remove another member.",
      );
    }
    if (refusal === "last_owner") {
      throw PlatformError.conflict("sandbox_last_owner", "The last owner cannot be removed.");
    }
    await this.repository.removeMember(membership.tenantId, asId<"SandboxPersonId">(target));
    await this.audit.record({
      tenantId: membership.tenantId,
      actor: "sandbox",
      action: "sandbox.member.removed",
      subjectType: "sandbox_person",
      subjectId: target,
    });
  }

  // --- API keys --------------------------------------------------------------------------------

  async createApiKey(context: SignedInContext, tenantId: string, label: string) {
    const membership = this.ownerIn(context, tenantId);
    const key = `edtp_${newOpaqueToken(32)}`;
    const id = newUuid();
    await this.apiKeys.create({
      id,
      tenantId: membership.tenantId,
      key,
      label,
      createdAt: this.clock.now(),
    });
    await this.audit.record({
      tenantId: membership.tenantId,
      actor: "sandbox",
      action: "sandbox.api_key.created",
      subjectType: "api_key",
      subjectId: id,
    });
    // Returned exactly once, as the platform's own tenant keys are.
    return { id, key, label };
  }

  async listApiKeys(context: SignedInContext, tenantId: string) {
    const membership = this.ownerIn(context, tenantId);
    return this.repository.apiKeysOf(membership.tenantId);
  }

  async revokeApiKey(context: SignedInContext, tenantId: string, keyId: string) {
    const membership = this.ownerIn(context, tenantId);
    if (!(await this.repository.revokeApiKey(membership.tenantId, keyId, this.clock.now()))) {
      throw PlatformError.notFound("API key");
    }
    await this.audit.record({
      tenantId: membership.tenantId,
      actor: "sandbox",
      action: "sandbox.api_key.revoked",
      subjectType: "api_key",
      subjectId: keyId,
    });
  }
}

const withSlash = (url: string) => (url.endsWith("/") ? url : `${url}/`);

export type { SignInAttemptId };
