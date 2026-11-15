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
  normaliseEmail,
  type Person,
  type PersonId,
  type Role,
  type SandboxOrganisation,
  SIGN_IN_ATTEMPT_TTL_MS,
  type SignInAttemptId,
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
import type { AccessIdentity, AccessIdentityVerifier } from "./access-identity.js";

/**
 * The sandbox's people: organisations, members, invitations and API keys (ADR 0015), entered by the
 * identity Cloudflare Access verified (ADR 0018).
 *
 * A person is their verified e-mail address. Presenting a PID is optional: a presentation to the
 * sandbox operator's own sign-in verifier, under one policy whose result is a single
 * `PseudonymousSubject`. This service never sees a PID value: it reads the subject from the
 * presentation's result and nothing else.
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

export type EnterOutcome =
  | { readonly outcome: "signed_in"; readonly sessionToken: string }
  /** The address Access verified, so the person sees whom they are about to create. */
  | { readonly outcome: "needs_profile"; readonly email: string };

export type PidPresentationOutcome =
  | { readonly outcome: "pending" }
  | { readonly outcome: "failed"; readonly failureCode: string }
  | { readonly outcome: "pid_presented" };

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
    private readonly access: AccessIdentityVerifier,
  ) {}

  // --- entering by the Access identity (ADR 0018) ------------------------------------------------

  /** The identity in Access's assertion, or `unauthenticated` (ADR 0018 Decision 1). */
  identify(assertion: string | undefined): Promise<AccessIdentity> {
    return this.access.verify(assertion);
  }

  /**
   * A person Access has identified arrives. Known: a session. Unknown: they are asked for a display
   * name — and, if they came to sign up, an organisation — before anything is created.
   */
  async enter(identity: AccessIdentity): Promise<EnterOutcome> {
    const person = await this.repository.findPersonByEmail(identity.email);
    if (!person) return { outcome: "needs_profile", email: identity.email };
    return {
      outcome: "signed_in",
      sessionToken: await this.openSession(person.id, this.clock.now()),
    };
  }

  /**
   * The first visit: the person, keyed by the address Access verified, with the display name they
   * typed. Optionally an organisation they own, or an invitation they accept. One session.
   */
  async createProfile(
    identity: AccessIdentity,
    input: {
      readonly displayName: string;
      readonly organisation?: OrganisationProfile;
      readonly invitationToken?: string;
    },
  ): Promise<{ readonly sessionToken: string; readonly organisation?: SandboxOrganisation }> {
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
    if (await this.repository.findPersonByEmail(identity.email)) {
      throw PlatformError.conflict("sandbox_person_exists", "You already have an account.");
    }
    const now = this.clock.now();
    // The invitation is checked before the person exists, so a refused one creates nothing.
    const invitation = input.invitationToken
      ? await this.openInvitation(input.invitationToken, identity.email)
      : undefined;
    const person: Person = {
      id: asId<"SandboxPersonId">(newUuid()),
      email: identity.email,
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
    if (input.organisation) {
      organisation = await this.createOrganisation(person.id, input.organisation, now);
    }
    if (invitation) await this.join(invitation.id, person.id, now);
    return {
      sessionToken: await this.openSession(person.id, now),
      ...(organisation ? { organisation } : {}),
    };
  }

  /**
   * ADR 0018 Decision 2: a session is good only together with an assertion for the same address.
   * Anything else — no assertion, a bad one, another address — ends the session.
   */
  async checkSession(sessionToken: string, assertion: string | undefined): Promise<void> {
    let identity: AccessIdentity;
    try {
      identity = await this.access.verify(assertion);
    } catch (error) {
      await this.repository.endSession(sessionToken, this.clock.now());
      throw error;
    }
    const session = await this.repository.findSession(sessionToken);
    const person = session ? await this.repository.findPerson(session.personId) : undefined;
    if (!person || person.email !== identity.email) {
      await this.repository.endSession(sessionToken, this.clock.now());
      throw PlatformError.unauthenticated();
    }
  }

  // --- invitations ------------------------------------------------------------------------------

  private async openInvitation(token: string, email: string | undefined) {
    const invitation = await this.repository.findInvitationByToken(token);
    if (!invitation) throw PlatformError.notFound("Invitation");
    const refusal = checkInvitation(invitation, this.clock.now(), email);
    if (refusal === "for_another_address") {
      throw PlatformError.forbidden(
        "invitation_for_another_address",
        "This invitation was sent to another address.",
      );
    }
    if (refusal) {
      throw PlatformError.conflict(`invitation_${refusal}`, `The invitation is ${refusal}.`);
    }
    return invitation;
  }

  /** What an invitation link offers, to the person holding it. Names no address. */
  async invitation(token: string, identity: AccessIdentity) {
    const invitation = await this.openInvitation(token, identity.email);
    return { role: invitation.role, expiresAt: invitation.expiresAt };
  }

  /** A signed-in person accepts an invitation addressed to them. */
  async acceptInvitation(context: SignedInContext, token: string): Promise<void> {
    const invitation = await this.openInvitation(token, context.person.email);
    await this.join(invitation.id, context.person.id, this.clock.now());
  }

  // --- presenting a PID, optionally (ADR 0018 Decision 3) ----------------------------------------

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
        "PID presentation is not configured.",
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
        "PID presentation is unavailable: its trust configuration is not separate from the participants'.",
      );
    }
  }

  async startPidPresentation(
    context: SignedInContext,
    input: {
      readonly interactionType: "SAME_DEVICE" | "QR";
      readonly correlationId: CorrelationId;
    },
  ) {
    await this.assertSignInTrustIsSeparate();
    const view = await this.presentations.create({
      tenantId: this.settings.operatorTenantId,
      policyId: asId<"PresentationPolicyId">(this.settings.signInPolicyId),
      businessReference: "sandbox-present-pid",
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
        purpose: "present_pid",
        personId: context.person.id,
        presentationId: view.presentationId,
        createdAt: now,
        expiresAt,
      },
      bindingToken,
    );
    if (input.interactionType === "SAME_DEVICE") {
      const back = new URL("pid/return", withSlash(this.settings.portalPublicUrl));
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

  /**
   * Poll a PID presentation the signed-in person started. When it has verified, its subject is
   * recorded on the person: once, and never one another person already holds.
   */
  async completePidPresentation(
    context: SignedInContext,
    attemptId: string,
    bindingToken: string,
    correlationId: CorrelationId,
  ): Promise<PidPresentationOutcome> {
    const attempt = await this.repository.findSignInAttempt(
      asId<"SandboxSignInAttemptId">(attemptId),
      bindingToken,
    );
    // Unknown, another browser's, and another person's all look the same.
    if (!attempt || attempt.personId !== context.person.id) {
      throw PlatformError.notFound("PID presentation");
    }
    if (attempt.completedAt) {
      throw PlatformError.conflict("sign_in_attempt_used", "This presentation has been used.");
    }
    if (attempt.expiresAt.getTime() <= this.clock.now().getTime()) {
      throw PlatformError.conflict("sign_in_attempt_expired", "This presentation has expired.");
    }
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
    if (!(await this.repository.completeSignInAttempt(attempt.id, now))) {
      throw PlatformError.conflict("sign_in_attempt_used", "This presentation has been used.");
    }
    if (context.person.subject) {
      return context.person.subject === subject
        ? { outcome: "pid_presented" }
        : { outcome: "failed", failureCode: "pid_differs_from_recorded" };
    }
    const holder = await this.repository.findPersonBySubject(subject);
    if (holder) return { outcome: "failed", failureCode: "pid_recorded_for_another_person" };
    if (!(await this.repository.recordSubject(context.person.id, subject))) {
      return { outcome: "failed", failureCode: "pid_differs_from_recorded" };
    }
    await this.audit.record({
      tenantId: this.settings.operatorTenantId,
      actor: "sandbox",
      action: "sandbox.person.pid_presented",
      subjectType: "sandbox_person",
      subjectId: context.person.id,
    });
    return { outcome: "pid_presented" };
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

  /**
   * The membership, refused while the organisation is suspended (specification J9): a suspended
   * participant creates nothing more, hosted or take-away.
   */
  async activeMembershipIn(context: SignedInContext, tenantId: string): Promise<Membership> {
    const membership = this.membershipIn(context, tenantId);
    const organisation = await this.repository.findOrganisation(membership.tenantId);
    if (!organisation) throw PlatformError.notFound("Organisation");
    if (organisation.status !== "ACTIVE") {
      throw PlatformError.forbidden(
        "sandbox_organisation_suspended",
        "The organisation is suspended.",
      );
    }
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

  /** An invitation to one address (ADR 0018 Decision 4). The sandbox sends no e-mail. */
  async invite(context: SignedInContext, tenantId: string, role: Role, rawEmail: string) {
    const membership = this.ownerIn(context, tenantId);
    const email = normaliseEmail(rawEmail);
    if (!email) {
      throw PlatformError.validation("invalid_email", "Invalid e-mail address.", [
        { path: "email", code: "invalid", message: "Must be an e-mail address." },
      ]);
    }
    const now = this.clock.now();
    const token = newOpaqueToken(32);
    const invitation = {
      id: asId<"SandboxInvitationId">(newUuid()),
      tenantId: membership.tenantId,
      role,
      email,
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
    return { invitationToken: token, role, email, expiresAt: invitation.expiresAt };
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
