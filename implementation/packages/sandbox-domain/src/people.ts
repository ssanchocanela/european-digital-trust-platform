import type { Branded, TenantId } from "@edtp/shared";

/**
 * People in the sandbox, their organisations, and how they get in (ADR 0015, amended by ADR 0018).
 *
 * Pure: no I/O, no clock of its own. Every rule a test can state is a function here.
 */

export type PersonId = Branded<string, "SandboxPersonId">;
export type InvitationId = Branded<string, "SandboxInvitationId">;
export type SignInAttemptId = Branded<string, "SandboxSignInAttemptId">;

/**
 * A person, known by the e-mail address Cloudflare Access verified and the name they typed
 * (ADR 0018). A person who chose to present a PID also has a pseudonymous subject. Nothing from
 * their PID is kept: the subject is a `PseudonymousSubject` derivation, never the values it came
 * from.
 */
export interface Person {
  readonly id: PersonId;
  readonly email: string;
  readonly subject?: string;
  readonly displayName: string;
  readonly createdAt: Date;
  readonly lastSignInAt: Date;
}

export const DISPLAY_NAME_MAX = 80;

/** A display name: trimmed, 1–80 characters, no control characters. */
export function normaliseDisplayName(raw: string): string | undefined {
  const value = raw.normalize("NFC").trim().replace(/\s+/g, " ");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
  if (
    value.length === 0 ||
    value.length > DISPLAY_NAME_MAX ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return undefined;
  }
  return value;
}

export const EMAIL_MAX = 254;

/**
 * An e-mail address as the sandbox keys a person by it: trimmed and lower-cased. Deliberately loose —
 * Access has already proved the address can receive mail — but refuses what cannot be one: no `@`, a
 * space, a control character, over 254 characters.
 */
export function normaliseEmail(raw: string): string | undefined {
  const value = raw.trim().toLowerCase();
  if (value.length === 0 || value.length > EMAIL_MAX) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return undefined;
  const at = value.lastIndexOf("@");
  if (at < 1 || at === value.length - 1 || value.indexOf("@") !== at) return undefined;
  return value;
}

// --- Organisations ---------------------------------------------------------------------------

export const ORGANISATION_STATUSES = ["ACTIVE", "SUSPENDED"] as const;
export type OrganisationStatus = (typeof ORGANISATION_STATUSES)[number];

/**
 * A participant organisation. One sandbox organisation is one platform `Tenant`, and its
 * registration data lives in the platform's own `Organisation` (ADR 0015 Decision 8).
 *
 * `verified` is the literal `false`: the sandbox does not check an organisation's identity or a
 * person's authority to act for it (ADR 0015 Decision 6). A type that cannot say `true` is the
 * cheapest way to keep it from being claimed.
 */
export interface SandboxOrganisation {
  readonly tenantId: TenantId;
  /** `SB:<CC>-<n>`, the identifier every certificate carries (specification Q-S1). */
  readonly localIdentifier: string;
  readonly country: string;
  /** An EUID the organisation declared. Shown in the register as declared; never in a certificate. */
  readonly declaredEuid?: string;
  readonly verified: false;
  readonly status: OrganisationStatus;
  readonly createdAt: Date;
}

/** The two-character local type reference of EN 319 412-1 LEG-5.1.4-03 item 7 the sandbox uses. */
export const SANDBOX_IDENTIFIER_SCHEME = "SB";

const COUNTRY = /^[A-Z]{2}$/;

/**
 * `SB:<CC>-<n>`: the locally defined form of EN 319 412-1 V1.7.1 LEG-5.1.4-03 item 7, numbered by
 * the sandbox, six digits at least. It cannot be read as a VAT, NTR or LEI number.
 */
export function formatSandboxIdentifier(country: string, number: number): string {
  if (!COUNTRY.test(country)) throw new Error("country must be an ISO 3166-1 alpha-2 code");
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error("number must be a positive integer");
  return `${SANDBOX_IDENTIFIER_SCHEME}:${country}-${String(number).padStart(6, "0")}`;
}

export const isSandboxIdentifier = (value: string): boolean =>
  /^SB:[A-Z]{2}-\d{6,}$/.test(value);

// --- Membership ------------------------------------------------------------------------------

export const ROLES = ["owner", "member"] as const;
export type Role = (typeof ROLES)[number];

export interface Membership {
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly role: Role;
  readonly createdAt: Date;
}

export type MembershipRefusal = "last_owner" | "not_a_member" | "not_an_owner";

/** Only an owner manages members and keys (ADR 0015 Decision 7). */
export const canManage = (actor: Membership | undefined): boolean => actor?.role === "owner";

/**
 * Whether `actor` may remove `target`. An owner may remove anyone but the last owner; a member may
 * remove only themselves, and then not if they are the last owner.
 */
export function checkRemoval(
  members: readonly Membership[],
  actor: PersonId,
  target: PersonId,
): MembershipRefusal | undefined {
  const actorMembership = members.find((m) => m.personId === actor);
  const targetMembership = members.find((m) => m.personId === target);
  if (!actorMembership || !targetMembership) return "not_a_member";
  if (actor !== target && actorMembership.role !== "owner") return "not_an_owner";
  if (
    targetMembership.role === "owner" &&
    members.filter((m) => m.role === "owner").length === 1
  ) {
    return "last_owner";
  }
  return undefined;
}

// --- Invitations -----------------------------------------------------------------------------

export const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;

export interface Invitation {
  readonly id: InvitationId;
  readonly tenantId: TenantId;
  readonly role: Role;
  /** The only address that may accept it (ADR 0018 Decision 4). Absent on invitations made before. */
  readonly email?: string;
  readonly createdBy: PersonId;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly acceptedAt?: Date;
  readonly acceptedBy?: PersonId;
}

export type InvitationRefusal = "used" | "expired" | "for_another_address";

/**
 * Single use, 72 hours (ADR 0015 Decision 7), and only by the address it names (ADR 0018
 * Decision 4): a forwarded link is useless to anyone else. An invitation that names no address —
 * one made before ADR 0018 — is accepted by nobody.
 */
export function checkInvitation(
  invitation: Invitation,
  at: Date,
  acceptingEmail?: string,
): InvitationRefusal | undefined {
  if (invitation.acceptedAt) return "used";
  if (at.getTime() >= invitation.expiresAt.getTime()) return "expired";
  if (acceptingEmail !== undefined && invitation.email !== acceptingEmail) {
    return "for_another_address";
  }
  return undefined;
}

// --- Sessions --------------------------------------------------------------------------------

export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;

export interface Session {
  readonly personId: PersonId;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly endedAt?: Date;
}

/** 30 minutes idle, 8 hours absolute, and never after sign-out (ADR 0015 Decision 5). */
export function isSessionLive(session: Session, at: Date): boolean {
  if (session.endedAt) return false;
  const t = at.getTime();
  return (
    t - session.lastSeenAt.getTime() < SESSION_IDLE_MS &&
    t - session.createdAt.getTime() < SESSION_ABSOLUTE_MS
  );
}

// --- Sign-in ---------------------------------------------------------------------------------

/**
 * What a presentation to the sign-in verifier is for. Since ADR 0018 there is one: a signed-in person
 * chooses to present a PID. The attempt is bound to the browser that started it and to the person,
 * so a presentation completed on a phone reaches only the page that asked for it.
 */
export const SIGN_IN_PURPOSES = ["present_pid"] as const;
export type SignInPurpose = (typeof SIGN_IN_PURPOSES)[number];

export const SIGN_IN_ATTEMPT_TTL_MS = 10 * 60 * 1000;

/**
 * The sign-in verifier must never trust an anchor that a participant can place (ADR 0015 Decision 2,
 * S0 §6.1): otherwise a participant acting as PID Provider could mint a PID in anyone's name and sign
 * in as them. Returns the shared sources; the caller refuses to start when there are any.
 */
export function sharedTrustSources(
  signInSources: readonly string[],
  participantSources: readonly string[],
): readonly string[] {
  const participant = new Set(participantSources);
  return signInSources.filter((s) => participant.has(s));
}
