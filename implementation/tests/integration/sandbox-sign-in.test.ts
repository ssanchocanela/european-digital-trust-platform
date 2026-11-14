import type { TenantId } from "@edtp/shared";
import { asId, newCorrelationId, PlatformError } from "@edtp/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  SandboxService,
  type SandboxService as SandboxServiceType,
  type SignedInContext,
} from "../../apps/platform-api/src/modules/sandbox/sandbox.service.js";
import { createHarness, type Harness } from "../support/harness.js";
import { identity, testAccess } from "../support/sandbox.js";
import { seedTenant } from "../support/seed.js";

/**
 * People in the sandbox (ADR 0015 as amended by ADR 0018): entering by the address Cloudflare Access
 * verified, sessions bound to it, invitations by address, and the optional PID presentation —
 * against the real services and database, with the fake verifier standing in for the engine.
 */
const REFERENCE_PID_LIST = "https://reference.test/lote/PIDProviders.jwt";
const SANDBOX_PID_LIST = "https://sandbox.test/lote/PIDProviders.jwt";

const ana = {
  given_name: "Ana",
  family_name: "Pérez García",
  birthdate: "1990-04-01",
  issuing_authority: "Test PID Provider",
  issuing_country: "ES",
};
const bruno = { ...ana, given_name: "Bruno", birthdate: "1985-12-24" };

const SOURCE_PATHS = [
  ["given_name"],
  ["family_name"],
  ["birthdate"],
  ["issuing_authority"],
  ["issuing_country"],
];

let harness: Harness;
let operatorTenantId: TenantId;
let signInPolicyId: string;
let sandbox: SandboxServiceType;

const profile = {
  legalName: "Banco Ejemplo S.A.",
  tradeName: "Banco Ejemplo",
  country: "ES",
  isPublicSectorBody: false,
};

async function publishSignInPolicy(anchorRefs: readonly string[]) {
  await harness.deps.services.policies.createVersion({
    tenantId: operatorTenantId,
    policyId: asId<"PresentationPolicyId">(signInPolicyId),
    purpose: [{ lang: "en", value: "Sign in to the sandbox" }],
    credentialRequirements: [
      { credentialType: "urn:eudi:pid:1", acceptedFormats: ["dc+sd-jwt"] },
    ],
    requestedClaims: SOURCE_PATHS.map((path) => ({ path })),
    resultPolicy: {
      kind: "DERIVED_CLAIMS",
      derivations: [
        { name: "PseudonymousSubject", sourcePaths: SOURCE_PATHS, outputClaim: "subject" },
      ],
    },
    trustPolicy: {
      anchorSources: anchorRefs.map((ref) => ({
        kind: "ETSI_TS_119_602_LOTE" as const,
        domain: "PID_PROVIDER" as const,
        ref,
      })),
      statusCheckMode: "STRICT",
    },
    publish: true,
  });
}

const ANA = "ana@example.test";
const BRUNO = "bruno@example.test";

async function signUp(email: string, name: string) {
  return sandbox.createProfile(identity(email), { displayName: name, organisation: profile });
}

/** The optional PID presentation, through the fake engine: start, the wallet presents, poll. */
async function presentPid(context: SignedInContext, disclosed: Record<string, unknown>) {
  const attempt = await sandbox.startPidPresentation(context, {
    interactionType: "SAME_DEVICE",
    correlationId: newCorrelationId(),
  });
  harness.verifier.settleLastVerified(disclosed);
  const completion = await sandbox.completePidPresentation(
    context,
    attempt.attemptId,
    attempt.bindingToken,
    newCorrelationId(),
  );
  return { attempt, completion };
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof PlatformError ? error.code : String(error);
  }
  return "no error";
};

beforeAll(async () => {
  harness = await createHarness({
    env: { PSEUDONYM_MASTER_KEY: Buffer.alloc(32, 3).toString("base64") },
  });
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  const operator = await seedTenant(harness, {
    name: "EDTP Sandbox operator",
    registeredClaims: SOURCE_PATHS,
    publishPolicy: false,
  });
  operatorTenantId = operator.tenantId;
  signInPolicyId = operator.policyId;
  await publishSignInPolicy([REFERENCE_PID_LIST]);
  sandbox = new SandboxService(
    {
      operatorTenantId,
      signInPolicyId,
      participantTrustSources: [SANDBOX_PID_LIST],
      portalPublicUrl: "https://portal.sandbox.test",
    },
    harness.deps.repositories.sandbox,
    harness.deps.repositories.policies,
    harness.deps.repositories.apiKeys,
    harness.deps.services.presentations,
    harness.deps.hostedFormReturns,
    harness.deps.services.audit,
    harness.clock,
    harness.deps.logger,
    testAccess,
  );
});

describe("entering by the Access identity (ADR 0018 Decision 1)", () => {
  it("asks an unknown address for a profile, then creates the person, the organisation and an owner session", async () => {
    expect(await sandbox.enter(identity(ANA))).toEqual({ outcome: "needs_profile", email: ANA });
    const { sessionToken, organisation } = await signUp(ANA, "Ana");
    expect(organisation?.localIdentifier).toMatch(/^SB:ES-\d{6}$/);
    expect(organisation?.verified).toBe(false);
    const context = await sandbox.authenticate(sessionToken);
    expect(context.person.displayName).toBe("Ana");
    expect(context.person.email).toBe(ANA);
    expect(context.person.subject).toBeUndefined();
    expect(context.memberships).toEqual([
      expect.objectContaining({ tenantId: organisation?.tenantId, role: "owner" }),
    ]);
  });

  it("signs a known address straight in, as the same person", async () => {
    const { sessionToken } = await signUp(ANA, "Ana");
    const first = await sandbox.authenticate(sessionToken);
    const again = await sandbox.enter(identity(ANA));
    expect(again.outcome).toBe("signed_in");
    if (again.outcome !== "signed_in") return;
    expect((await sandbox.authenticate(again.sessionToken)).person.id).toBe(first.person.id);
  });

  it("creates one person per address, and refuses a second profile", async () => {
    await signUp(ANA, "Ana");
    expect(await code(signUp(ANA, "Ana again"))).toBe("sandbox_person_exists");
  });

  it("lets a person in without an organisation, and refuses a bad display name", async () => {
    const done = await sandbox.createProfile(identity(BRUNO), { displayName: "Bruno" });
    expect((await sandbox.authenticate(done.sessionToken)).memberships).toEqual([]);
    expect(await code(sandbox.createProfile(identity(ANA), { displayName: "   " }))).toBe(
      "invalid_display_name",
    );
  });

  it("numbers organisations in sequence and never reuses a number", async () => {
    const first = await signUp(ANA, "Ana");
    const second = await signUp(BRUNO, "Bruno");
    const number = (id?: string) => Number(id?.split("-")[1]);
    // The sequence survives a truncation, so numbers keep rising across tests — which is the point.
    expect(number(second.organisation?.localIdentifier)).toBe(
      number(first.organisation?.localIdentifier) + 1,
    );
  });
});

describe("sessions follow the Access identity (ADR 0018 Decision 2)", () => {
  it("honours a session with an assertion for the same address", async () => {
    const { sessionToken } = await signUp(ANA, "Ana");
    await sandbox.checkSession(sessionToken, ANA);
    expect((await sandbox.authenticate(sessionToken)).person.email).toBe(ANA);
  });

  it("ends the session when the assertion names another address", async () => {
    const { sessionToken } = await signUp(ANA, "Ana");
    await signUp(BRUNO, "Bruno");
    expect(await code(sandbox.checkSession(sessionToken, BRUNO))).toBe("unauthenticated");
    expect(await code(sandbox.authenticate(sessionToken))).toBe("unauthenticated");
  });

  it("ends the session when there is no assertion at all", async () => {
    const { sessionToken } = await signUp(ANA, "Ana");
    expect(await code(sandbox.checkSession(sessionToken, undefined))).toBe("unauthenticated");
    expect(await code(sandbox.authenticate(sessionToken))).toBe("unauthenticated");
  });

  it("ends a session at sign-out", async () => {
    const { sessionToken } = await signUp(ANA, "Ana");
    await sandbox.signOut(sessionToken);
    expect(await code(sandbox.authenticate(sessionToken))).toBe("unauthenticated");
  });
});

describe("presenting a PID, optionally (ADR 0018 Decision 3)", () => {
  it("returns the wallet to the portal, keyed by the attempt", async () => {
    const { sessionToken } = await signUp(ANA, "Ana");
    const context = await sandbox.authenticate(sessionToken);
    const attempt = await sandbox.startPidPresentation(context, {
      interactionType: "SAME_DEVICE",
      correlationId: newCorrelationId(),
    });
    const stored = await harness.deps.repositories.sandbox.findSignInAttempt(
      attempt.attemptId,
      attempt.bindingToken,
    );
    expect(stored?.personId).toBe(context.person.id);
    expect(harness.deps.hostedFormReturns.destination(stored?.presentationId ?? "")).toBe(
      `https://portal.sandbox.test/pid/return?attempt=${attempt.attemptId}`,
    );
  });

  it("records the subject once, and recognises the same PID whatever its spacing or case", async () => {
    const { sessionToken } = await signUp(ANA, "Ana");
    const context = await sandbox.authenticate(sessionToken);
    expect((await presentPid(context, ana)).completion.outcome).toBe("pid_presented");
    const after = await sandbox.authenticate(sessionToken);
    expect(after.person.subject).toMatch(/.{20,}/);
    const again = await presentPid(after, {
      ...ana,
      given_name: " ANA ",
      family_name: "pérez  garcía",
    });
    expect(again.completion.outcome).toBe("pid_presented");
    expect((await sandbox.authenticate(sessionToken)).person.subject).toBe(
      after.person.subject,
    );
  });

  it("refuses a different PID once one is recorded", async () => {
    const { sessionToken } = await signUp(ANA, "Ana");
    await presentPid(await sandbox.authenticate(sessionToken), ana);
    const { completion } = await presentPid(await sandbox.authenticate(sessionToken), bruno);
    expect(completion).toEqual({ outcome: "failed", failureCode: "pid_differs_from_recorded" });
  });

  it("never records one PID for two people", async () => {
    const a = await signUp(ANA, "Ana");
    const b = await signUp(BRUNO, "Bruno");
    await presentPid(await sandbox.authenticate(a.sessionToken), ana);
    const brunoContext = await sandbox.authenticate(b.sessionToken);
    const { completion } = await presentPid(brunoContext, ana);
    expect(completion).toEqual({
      outcome: "failed",
      failureCode: "pid_recorded_for_another_person",
    });
    expect((await sandbox.authenticate(b.sessionToken)).person.subject).toBeUndefined();
  });

  it("answers another browser's binding, and another person's attempt, as not found", async () => {
    const a = await signUp(ANA, "Ana");
    const b = await signUp(BRUNO, "Bruno");
    const anaContext = await sandbox.authenticate(a.sessionToken);
    const attempt = await sandbox.startPidPresentation(anaContext, {
      interactionType: "SAME_DEVICE",
      correlationId: newCorrelationId(),
    });
    harness.verifier.settleLastVerified(ana);
    expect(
      await code(
        sandbox.completePidPresentation(
          anaContext,
          attempt.attemptId,
          "x".repeat(43),
          newCorrelationId(),
        ),
      ),
    ).toBe("not_found");
    expect(
      await code(
        sandbox.completePidPresentation(
          await sandbox.authenticate(b.sessionToken),
          attempt.attemptId,
          attempt.bindingToken,
          newCorrelationId(),
        ),
      ),
    ).toBe("not_found");
  });

  it("is single use, and expires after ten minutes", async () => {
    const { sessionToken } = await signUp(ANA, "Ana");
    const context = await sandbox.authenticate(sessionToken);
    const { attempt } = await presentPid(context, ana);
    expect(
      await code(
        sandbox.completePidPresentation(
          context,
          attempt.attemptId,
          attempt.bindingToken,
          newCorrelationId(),
        ),
      ),
    ).toBe("sign_in_attempt_used");
    const late = await sandbox.startPidPresentation(context, {
      interactionType: "SAME_DEVICE",
      correlationId: newCorrelationId(),
    });
    harness.clock.advance(10 * 60 * 1000);
    expect(
      await code(
        sandbox.completePidPresentation(
          context,
          late.attemptId,
          late.bindingToken,
          newCorrelationId(),
        ),
      ),
    ).toBe("sign_in_attempt_expired");
  });
});

describe("the sign-in verifier's trust anchors (ADR 0015 Decision 2)", () => {
  const start = async () => {
    const { sessionToken } = await signUp(ANA, "Ana");
    return sandbox.startPidPresentation(await sandbox.authenticate(sessionToken), {
      interactionType: "SAME_DEVICE",
      correlationId: newCorrelationId(),
    });
  };

  it("refuses to start when the policy trusts a list participants are placed on", async () => {
    await publishSignInPolicy([REFERENCE_PID_LIST, SANDBOX_PID_LIST]);
    expect(await code(start())).toBe("sandbox_sign_in_misconfigured");
  });

  it("refuses to start when the policy names no anchors at all", async () => {
    await publishSignInPolicy([]);
    expect(await code(start())).toBe("sandbox_sign_in_misconfigured");
  });
});

describe("members, invitations and keys", () => {
  it("lets the invited address join, as a member who cannot manage keys; once", async () => {
    const owner = await signUp(ANA, "Ana");
    const ownerContext = await sandbox.authenticate(owner.sessionToken);
    const orgId = owner.organisation?.tenantId as string;
    const { invitationToken, email } = await sandbox.invite(
      ownerContext,
      orgId,
      "member",
      " Bruno@Example.TEST ",
    );
    expect(email).toBe(BRUNO);
    expect(await sandbox.invitation(invitationToken, identity(BRUNO))).toEqual(
      expect.objectContaining({ role: "member" }),
    );

    const joined = await sandbox.createProfile(identity(BRUNO), {
      displayName: "Bruno",
      invitationToken,
    });
    const memberContext = await sandbox.authenticate(joined.sessionToken);
    expect(memberContext.memberships).toEqual([
      expect.objectContaining({ tenantId: orgId, role: "member" }),
    ]);
    expect(await code(sandbox.createApiKey(memberContext, orgId, "ci"))).toBe(
      "sandbox_owner_required",
    );
    expect(await code(sandbox.acceptInvitation(memberContext, invitationToken))).toBe(
      "invitation_used",
    );
  });

  it("refuses an invitation to anyone but its address, and creates nothing for them", async () => {
    const owner = await signUp(ANA, "Ana");
    const ownerContext = await sandbox.authenticate(owner.sessionToken);
    const orgId = owner.organisation?.tenantId as string;
    const { invitationToken } = await sandbox.invite(ownerContext, orgId, "owner", BRUNO);
    const eve = "eve@example.test";
    expect(await code(sandbox.invitation(invitationToken, identity(eve)))).toBe(
      "invitation_for_another_address",
    );
    expect(
      await code(sandbox.createProfile(identity(eve), { displayName: "Eve", invitationToken })),
    ).toBe("invitation_for_another_address");
    expect(await sandbox.enter(identity(eve))).toEqual({ outcome: "needs_profile", email: eve });
    // A signed-in person with another address cannot accept it either.
    const other = await signUp("carla@example.test", "Carla");
    expect(
      await code(
        sandbox.acceptInvitation(
          await sandbox.authenticate(other.sessionToken),
          invitationToken,
        ),
      ),
    ).toBe("invitation_for_another_address");
  });

  it("lets a signed-in person accept an invitation to their address", async () => {
    const owner = await signUp(ANA, "Ana");
    const other = await signUp(BRUNO, "Bruno");
    const orgId = owner.organisation?.tenantId as string;
    const { invitationToken } = await sandbox.invite(
      await sandbox.authenticate(owner.sessionToken),
      orgId,
      "member",
      BRUNO,
    );
    await sandbox.acceptInvitation(
      await sandbox.authenticate(other.sessionToken),
      invitationToken,
    );
    expect((await sandbox.authenticate(other.sessionToken)).memberships).toEqual(
      expect.arrayContaining([expect.objectContaining({ tenantId: orgId, role: "member" })]),
    );
  });

  it("refuses an invitation to something that is not an address", async () => {
    const owner = await signUp(ANA, "Ana");
    expect(
      await code(
        sandbox.invite(
          await sandbox.authenticate(owner.sessionToken),
          owner.organisation?.tenantId as string,
          "member",
          "not an address",
        ),
      ),
    ).toBe("invalid_email");
  });

  it("issues an API key once, which then authenticates as the organisation's tenant", async () => {
    const owner = await signUp(ANA, "Ana");
    const context = await sandbox.authenticate(owner.sessionToken);
    const orgId = owner.organisation?.tenantId as string;
    const created = await sandbox.createApiKey(context, orgId, "ci");
    expect(await harness.deps.repositories.apiKeys.resolveTenant(created.key)).toBe(orgId);
    const listed = await sandbox.listApiKeys(context, orgId);
    expect(JSON.stringify(listed)).not.toContain(created.key);
    await sandbox.revokeApiKey(context, orgId, created.id);
    expect(await harness.deps.repositories.apiKeys.resolveTenant(created.key)).toBeUndefined();
  });

  it("never removes the last owner", async () => {
    const owner = await signUp(ANA, "Ana");
    const context = await sandbox.authenticate(owner.sessionToken);
    const orgId = owner.organisation?.tenantId as string;
    expect(await code(sandbox.removeMember(context, orgId, context.person.id))).toBe(
      "sandbox_last_owner",
    );
  });

  it("answers another organisation's id as not found, for every route", async () => {
    const a = await signUp(ANA, "Ana");
    const b = await signUp(BRUNO, "Bruno");
    const anaContext = await sandbox.authenticate(a.sessionToken);
    const other = b.organisation?.tenantId as string;
    for (const call of [
      sandbox.organisation(anaContext, other),
      sandbox.members(anaContext, other),
      sandbox.invite(anaContext, other, "member", "x@example.test"),
      sandbox.createApiKey(anaContext, other, "x"),
      sandbox.listApiKeys(anaContext, other),
    ]) {
      expect(await code(call)).toBe("not_found");
    }
  });
});

describe("privacy (ADR 0015 Decision 4, ADR 0018 Decision 5)", () => {
  it("keeps no PID value anywhere in the database, and no address in an audit record or a log", async () => {
    const { sessionToken } = await signUp(ANA, "Ana P.");
    await presentPid(await sandbox.authenticate(sessionToken), ana);
    await sandbox.checkSession(sessionToken, ANA);
    const { rows } = await harness.handle.pool.query<{ dump: string }>(
      `SELECT concat_ws('|',
         (SELECT coalesce(json_agg(t)::text, '') FROM sandbox_people t),
         (SELECT coalesce(json_agg(t)::text, '') FROM sandbox_sign_in_attempts t),
         (SELECT coalesce(json_agg(t)::text, '') FROM sandbox_organisations t),
         (SELECT coalesce(json_agg(t)::text, '') FROM presentation_results t),
         (SELECT coalesce(json_agg(t)::text, '') FROM audit_events t)
       ) AS dump`,
    );
    const dump = rows[0]?.dump ?? "";
    expect(dump.length).toBeGreaterThan(0);
    for (const value of ["Pérez", "1990-04-01", "Test PID Provider"]) {
      expect(dump, `the database must not hold '${value}'`).not.toContain(value);
    }
    const { rows: audit } = await harness.handle.pool.query<{ dump: string }>(
      "SELECT coalesce(json_agg(t)::text, '') AS dump FROM audit_events t",
    );
    expect(audit[0]?.dump ?? "").not.toContain(ANA);
    const logs = harness.logs.lines.join("\n");
    expect(logs).not.toContain("1990-04-01");
    expect(logs).not.toContain(ANA);
  });
});
