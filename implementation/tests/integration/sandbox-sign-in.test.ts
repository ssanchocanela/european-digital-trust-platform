import type { TenantId } from "@edtp/shared";
import { asId, newCorrelationId, PlatformError } from "@edtp/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SandboxService } from "../../apps/platform-api/src/modules/sandbox/sandbox.service.js";
import { createHarness, type Harness } from "../support/harness.js";
import { seedTenant } from "../support/seed.js";

/**
 * Sign-up and sign-in by PID (ADR 0015), against the real services and database with the fake
 * verifier standing in for the engine.
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
let sandbox: SandboxService;

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

/** Run a presentation through the fake engine: start, the wallet presents, the page polls. */
async function signInWith(
  disclosed: Record<string, unknown>,
  purpose: "sign_in" | "sign_up" | "accept_invitation",
  invitationToken?: string,
) {
  const attempt = await sandbox.startSignIn({
    purpose,
    ...(invitationToken ? { invitationToken } : {}),
    interactionType: "SAME_DEVICE",
    correlationId: newCorrelationId(),
  });
  harness.verifier.settleLastVerified(disclosed);
  const completion = await sandbox.completeSignIn(
    attempt.attemptId,
    attempt.bindingToken,
    newCorrelationId(),
  );
  return { attempt, completion };
}

async function signUp(person: Record<string, unknown>, name: string) {
  const { attempt, completion } = await signInWith(person, "sign_up");
  expect(completion.outcome).toBe("needs_profile");
  return sandbox.completeProfile({
    attemptId: attempt.attemptId,
    bindingToken: attempt.bindingToken,
    displayName: name,
    organisation: profile,
  });
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
  );
});

describe("sign-up", () => {
  it("creates the person, the organisation with an SB identifier, and an owner session", async () => {
    const { sessionToken, organisation } = await signUp(ana, "Ana");
    expect(organisation?.localIdentifier).toMatch(/^SB:ES-\d{6}$/);
    expect(organisation?.verified).toBe(false);
    const context = await sandbox.authenticate(sessionToken);
    expect(context.person.displayName).toBe("Ana");
    expect(context.memberships).toEqual([
      expect.objectContaining({ tenantId: organisation?.tenantId, role: "owner" }),
    ]);
  });

  it("returns the wallet to the portal, keyed by the attempt", async () => {
    const attempt = await sandbox.startSignIn({
      purpose: "sign_up",
      interactionType: "SAME_DEVICE",
      correlationId: newCorrelationId(),
    });
    const stored = await harness.deps.repositories.sandbox.findSignInAttempt(
      attempt.attemptId,
      attempt.bindingToken,
    );
    const destination = harness.deps.hostedFormReturns.destination(
      stored?.presentationId ?? "",
    );
    expect(destination).toBe(
      `https://portal.sandbox.test/sign-in/return?attempt=${attempt.attemptId}`,
    );
  });

  it("numbers organisations in sequence and never reuses a number", async () => {
    const first = await signUp(ana, "Ana");
    const second = await signUp(bruno, "Bruno");
    const number = (id?: string) => Number(id?.split("-")[1]);
    // The sequence survives a truncation, so numbers keep rising across tests — which is the point.
    expect(number(second.organisation?.localIdentifier)).toBe(
      number(first.organisation?.localIdentifier) + 1,
    );
  });

  it("refuses a sign-up without an organisation, or with a bad display name", async () => {
    const { attempt } = await signInWith(ana, "sign_up");
    expect(
      await code(
        sandbox.completeProfile({
          attemptId: attempt.attemptId,
          bindingToken: attempt.bindingToken,
          displayName: "Ana",
        }),
      ),
    ).toBe("organisation_required");
    expect(
      await code(
        sandbox.completeProfile({
          attemptId: attempt.attemptId,
          bindingToken: attempt.bindingToken,
          displayName: "   ",
          organisation: profile,
        }),
      ),
    ).toBe("invalid_display_name");
  });
});

describe("sign-in", () => {
  it("recognises a returning person whatever the spacing or case of the PID values", async () => {
    const { sessionToken } = await signUp(ana, "Ana");
    const first = await sandbox.authenticate(sessionToken);
    const { completion } = await signInWith(
      { ...ana, given_name: " ANA ", family_name: "pérez  garcía" },
      "sign_in",
    );
    expect(completion.outcome).toBe("signed_in");
    if (completion.outcome !== "signed_in") return;
    const again = await sandbox.authenticate(completion.sessionToken);
    expect(again.person.id).toBe(first.person.id);
  });

  it("does not sign in an unknown person, and that attempt cannot be turned into a sign-up", async () => {
    const { attempt, completion } = await signInWith(ana, "sign_in");
    expect(completion.outcome).toBe("unknown_person");
    expect(
      await code(
        sandbox.completeProfile({
          attemptId: attempt.attemptId,
          bindingToken: attempt.bindingToken,
          displayName: "Ana",
          organisation: profile,
        }),
      ),
    ).toBe("sign_in_attempt_used");
  });

  it("answers another browser's binding token as not found", async () => {
    const attempt = await sandbox.startSignIn({
      purpose: "sign_in",
      interactionType: "SAME_DEVICE",
      correlationId: newCorrelationId(),
    });
    harness.verifier.settleLastVerified(ana);
    expect(
      await code(sandbox.completeSignIn(attempt.attemptId, "x".repeat(43), newCorrelationId())),
    ).toBe("not_found");
  });

  it("is single use: a signed-in attempt cannot sign in twice", async () => {
    await signUp(ana, "Ana");
    const { attempt, completion } = await signInWith(ana, "sign_in");
    expect(completion.outcome).toBe("signed_in");
    expect(
      await code(
        sandbox.completeSignIn(attempt.attemptId, attempt.bindingToken, newCorrelationId()),
      ),
    ).toBe("sign_in_attempt_used");
  });

  it("expires after ten minutes", async () => {
    const attempt = await sandbox.startSignIn({
      purpose: "sign_in",
      interactionType: "SAME_DEVICE",
      correlationId: newCorrelationId(),
    });
    harness.clock.advance(10 * 60 * 1000);
    expect(
      await code(
        sandbox.completeSignIn(attempt.attemptId, attempt.bindingToken, newCorrelationId()),
      ),
    ).toBe("sign_in_attempt_expired");
  });

  it("ends a session at sign-out", async () => {
    const { sessionToken } = await signUp(ana, "Ana");
    await sandbox.signOut(sessionToken);
    expect(await code(sandbox.authenticate(sessionToken))).toBe("unauthenticated");
  });
});

describe("the sign-in trust anchors (ADR 0015 Decision 2)", () => {
  it("refuses to start when the sign-in policy trusts a list participants are placed on", async () => {
    await publishSignInPolicy([REFERENCE_PID_LIST, SANDBOX_PID_LIST]);
    expect(
      await code(
        sandbox.startSignIn({
          purpose: "sign_in",
          interactionType: "SAME_DEVICE",
          correlationId: newCorrelationId(),
        }),
      ),
    ).toBe("sandbox_sign_in_misconfigured");
  });

  it("refuses to start when the sign-in policy names no anchors at all", async () => {
    await publishSignInPolicy([]);
    expect(
      await code(
        sandbox.startSignIn({
          purpose: "sign_in",
          interactionType: "SAME_DEVICE",
          correlationId: newCorrelationId(),
        }),
      ),
    ).toBe("sandbox_sign_in_misconfigured");
  });
});

describe("members, invitations and keys", () => {
  it("lets an invited person join by PID, as a member who cannot manage keys", async () => {
    const owner = await signUp(ana, "Ana");
    const ownerContext = await sandbox.authenticate(owner.sessionToken);
    const orgId = owner.organisation?.tenantId as string;
    const { invitationToken } = await sandbox.invite(ownerContext, orgId, "member");

    const { attempt, completion } = await signInWith(
      bruno,
      "accept_invitation",
      invitationToken,
    );
    expect(completion.outcome).toBe("needs_profile");
    const joined = await sandbox.completeProfile({
      attemptId: attempt.attemptId,
      bindingToken: attempt.bindingToken,
      displayName: "Bruno",
    });
    const memberContext = await sandbox.authenticate(joined.sessionToken);
    expect(memberContext.memberships).toEqual([
      expect.objectContaining({ tenantId: orgId, role: "member" }),
    ]);
    expect(await code(sandbox.createApiKey(memberContext, orgId, "ci"))).toBe(
      "sandbox_owner_required",
    );

    // The invitation is single use.
    expect(
      await code(
        sandbox.startSignIn({
          purpose: "accept_invitation",
          invitationToken,
          interactionType: "SAME_DEVICE",
          correlationId: newCorrelationId(),
        }),
      ),
    ).toBe("invitation_used");
  });

  it("issues an API key once, which then authenticates as the organisation's tenant", async () => {
    const owner = await signUp(ana, "Ana");
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
    const owner = await signUp(ana, "Ana");
    const context = await sandbox.authenticate(owner.sessionToken);
    const orgId = owner.organisation?.tenantId as string;
    expect(await code(sandbox.removeMember(context, orgId, context.person.id))).toBe(
      "sandbox_last_owner",
    );
  });

  it("answers another organisation's id as not found, for every route", async () => {
    const a = await signUp(ana, "Ana");
    const b = await signUp(bruno, "Bruno");
    const anaContext = await sandbox.authenticate(a.sessionToken);
    const other = b.organisation?.tenantId as string;
    for (const call of [
      sandbox.organisation(anaContext, other),
      sandbox.members(anaContext, other),
      sandbox.invite(anaContext, other, "member"),
      sandbox.createApiKey(anaContext, other, "x"),
      sandbox.listApiKeys(anaContext, other),
    ]) {
      expect(await code(call)).toBe("not_found");
    }
  });
});

describe("privacy (ADR 0015 Decision 4)", () => {
  it("keeps no PID value anywhere in the database, not even in the presentation result", async () => {
    await signUp(ana, "Ana P.");
    await signInWith(ana, "sign_in");
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
    // And nothing in the logs either.
    expect(harness.logs.lines.join("\n")).not.toContain("1990-04-01");
  });
});
