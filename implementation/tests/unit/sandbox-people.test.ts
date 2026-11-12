import {
  checkInvitation,
  checkRemoval,
  formatSandboxIdentifier,
  INVITATION_TTL_MS,
  type Invitation,
  isSandboxIdentifier,
  isSessionLive,
  type Membership,
  normaliseDisplayName,
  type PersonId,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  sharedTrustSources,
} from "@edtp/sandbox-domain";
import { asId, type TenantId } from "@edtp/shared";
import { describe, expect, it } from "vitest";

const tenant = asId<"TenantId">("00000000-0000-4000-8000-000000000001") as TenantId;
const person = (n: number) => `p-${n}` as PersonId;
const at = new Date("2026-11-12T10:00:00Z");
const member = (n: number, role: "owner" | "member"): Membership => ({
  tenantId: tenant,
  personId: person(n),
  role,
  createdAt: at,
});

describe("sandbox identifiers (specification Q-S1)", () => {
  it("formats SB:<CC>-<n> with at least six digits", () => {
    expect(formatSandboxIdentifier("ES", 1)).toBe("SB:ES-000001");
    expect(formatSandboxIdentifier("DE", 1234567)).toBe("SB:DE-1234567");
    expect(isSandboxIdentifier("SB:ES-000001")).toBe(true);
  });

  it("refuses a bad country or number, and never matches a real scheme's form", () => {
    expect(() => formatSandboxIdentifier("es", 1)).toThrow();
    expect(() => formatSandboxIdentifier("ES", 0)).toThrow();
    expect(isSandboxIdentifier("VATES-B12345678")).toBe(false);
    expect(isSandboxIdentifier("NTRES-123456")).toBe(false);
  });
});

describe("display names", () => {
  it("normalises spacing and refuses empty, long or control-character names", () => {
    expect(normaliseDisplayName("  Ana   Pérez ")).toBe("Ana Pérez");
    expect(normaliseDisplayName("   ")).toBeUndefined();
    expect(normaliseDisplayName("x".repeat(81))).toBeUndefined();
    expect(normaliseDisplayName("Ana\u0007")).toBeUndefined();
  });
});

describe("membership (ADR 0015 Decision 7)", () => {
  const members = [member(1, "owner"), member(2, "member"), member(3, "member")];

  it("lets an owner remove a member, and a member remove themselves", () => {
    expect(checkRemoval(members, person(1), person(2))).toBeUndefined();
    expect(checkRemoval(members, person(2), person(2))).toBeUndefined();
  });

  it("refuses a member removing someone else", () => {
    expect(checkRemoval(members, person(2), person(3))).toBe("not_an_owner");
  });

  it("never removes the last owner, even at their own request", () => {
    expect(checkRemoval(members, person(1), person(1))).toBe("last_owner");
    const twoOwners = [...members, member(4, "owner")];
    expect(checkRemoval(twoOwners, person(1), person(4))).toBeUndefined();
  });

  it("refuses an actor or target from outside the organisation", () => {
    expect(checkRemoval(members, person(9), person(2))).toBe("not_a_member");
    expect(checkRemoval(members, person(1), person(9))).toBe("not_a_member");
  });
});

describe("invitations", () => {
  const invitation: Invitation = {
    id: asId<"SandboxInvitationId">("i-1"),
    tenantId: tenant,
    role: "member",
    createdBy: person(1),
    createdAt: at,
    expiresAt: new Date(at.getTime() + INVITATION_TTL_MS),
  };

  it("is valid for 72 hours and single use", () => {
    expect(
      checkInvitation(invitation, new Date(at.getTime() + INVITATION_TTL_MS - 1)),
    ).toBeUndefined();
    expect(checkInvitation(invitation, new Date(at.getTime() + INVITATION_TTL_MS))).toBe(
      "expired",
    );
    expect(checkInvitation({ ...invitation, acceptedAt: at, acceptedBy: person(2) }, at)).toBe(
      "used",
    );
  });
});

describe("sessions (ADR 0015 Decision 5)", () => {
  const session = { personId: person(1), createdAt: at, lastSeenAt: at };

  it("ends after 30 minutes idle", () => {
    expect(isSessionLive(session, new Date(at.getTime() + SESSION_IDLE_MS - 1))).toBe(true);
    expect(isSessionLive(session, new Date(at.getTime() + SESSION_IDLE_MS))).toBe(false);
  });

  it("ends after 8 hours however active", () => {
    const late = new Date(at.getTime() + SESSION_ABSOLUTE_MS);
    expect(
      isSessionLive({ ...session, lastSeenAt: new Date(late.getTime() - 1000) }, late),
    ).toBe(false);
  });

  it("ends at sign-out", () => {
    expect(isSessionLive({ ...session, endedAt: at }, at)).toBe(false);
  });
});

describe("the sign-in anchor set (ADR 0015 Decision 2, S0 §6.1)", () => {
  it("reports any source a participant could also place", () => {
    expect(sharedTrustSources(["ref-pid", "pid-demo"], ["sandbox-pid-list"])).toEqual([]);
    expect(sharedTrustSources(["ref-pid", "sandbox-pid-list"], ["sandbox-pid-list"])).toEqual([
      "sandbox-pid-list",
    ]);
  });
});
