import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../support/harness.js";
import { errorCode, identity, wireSandbox } from "../support/sandbox.js";

/**
 * The operator's section (ADR 0019), on a real database with the fake engine: who is an operator,
 * what they see, and the three actions — each audited under the operator's person id, never an
 * address.
 */
const OPERATOR = "op@example.test";

let harness: Harness;
let s: Awaited<ReturnType<typeof wireSandbox>>;

function csr(): string {
  const dir = mkdtempSync(join(tmpdir(), "sbx-csr-"));
  execFileSync("openssl", [
    "ecparam",
    "-name",
    "prime256v1",
    "-genkey",
    "-noout",
    "-out",
    join(dir, "k.pem"),
  ]);
  execFileSync("openssl", [
    "req",
    "-new",
    "-key",
    join(dir, "k.pem"),
    "-subj",
    "/CN=x",
    "-out",
    join(dir, "r.pem"),
  ]);
  return readFileSync(join(dir, "r.pem"), "utf8");
}

async function operator() {
  const done = await s.sandbox.createProfile(identity(OPERATOR), { displayName: "Operator" });
  return s.sandbox.authenticate(done.sessionToken);
}

async function participantWithCertificate() {
  const owner = await s.signUp(undefined, "Banco");
  const service = await s.certificates.createService(owner.context, owner.organisationId, {
    role: "service_provider",
    tradeName: "Banco Ejemplo",
    description: [{ lang: "en", value: "A test service" }],
    supportUri: "https://org.test/support",
    privacyPolicyUri: "https://org.test/privacy",
    infoUri: "https://org.test",
  });
  await s.certificates.issueAccessCertificate(
    owner.context,
    owner.organisationId,
    service.relyingPartyServiceId,
    { variant: "AC-00", csrPem: csr(), dnsNames: ["rp.example.test"] },
  );
  return owner;
}

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
  s = await wireSandbox(harness, { operatorEmails: [OPERATOR] });
});

describe("who is an operator (ADR 0019 §1)", () => {
  it("answers anyone not on the list as not found, on every view and action", async () => {
    const owner = await participantWithCertificate();
    const c = owner.context;
    for (const call of [
      s.admin.overview(c),
      s.admin.organisations(c),
      s.admin.organisation(c, owner.organisationId),
      s.admin.people(c),
      s.admin.invitations(c),
      s.admin.auditTrail(c),
      s.admin.suspend(c, owner.organisationId, "testing"),
      s.admin.revokeInvitation(c, "00000000-0000-4000-8000-000000000001"),
      s.admin.endSessions(c, c.person.id),
    ]) {
      expect(await errorCode(call)).toBe("not_found");
    }
    expect(s.sandbox.isOperator(c)).toBe(false);
  });

  it("recognises the configured address", async () => {
    expect(s.sandbox.isOperator(await operator())).toBe(true);
  });
});

describe("what the operator sees (ADR 0019 §2)", () => {
  it("counts, lists and details every organisation, with its members' addresses and quota use", async () => {
    const owner = await participantWithCertificate();
    const op = await operator();
    const overview = await s.admin.overview(op);
    expect(overview).toMatchObject({ activeOrganisations: 1, people: 2, certificates: 1 });

    const { organisations, quotas } = await s.admin.organisations(op);
    expect(organisations).toEqual([
      expect.objectContaining({
        tenantId: owner.organisationId,
        localIdentifier: expect.stringMatching(/^SB:ES-\d{6}$/),
        legalName: "Banco S.A.",
        status: "ACTIVE",
        members: 1,
        services: 1,
        certificates: 1,
      }),
    ]);
    expect(quotas.servicesPerOrganisation).toBe(10);

    const detail = await s.admin.organisation(op, owner.organisationId);
    expect(detail.members).toEqual([
      expect.objectContaining({ email: owner.email, role: "owner" }),
    ]);
    expect(detail.services).toEqual([
      expect.objectContaining({ serviceTradeName: "Banco Ejemplo", certificatesLastDay: 1 }),
    ]);
    expect(detail.certificates).toEqual([
      expect.objectContaining({ kind: "WRPAC", variant: "AC-00", revokedAt: null }),
    ]);

    const { people } = await s.admin.people(op);
    expect(people.map((p) => p.email).sort()).toEqual([owner.email, OPERATOR].sort());
  });

  it("lists pending invitations with their address, and the sandbox's audit trail", async () => {
    const owner = await participantWithCertificate();
    await s.sandbox.invite(owner.context, owner.organisationId, "member", "new@example.test");
    const op = await operator();
    const { invitations } = await s.admin.invitations(op);
    expect(invitations).toEqual([
      expect.objectContaining({ email: "new@example.test", role: "member" }),
    ]);
    const { records } = await s.admin.auditTrail(op, owner.organisationId);
    expect(records.map((r) => r.action)).toEqual(
      expect.arrayContaining(["sandbox.organisation.created", "sandbox.invitation.created"]),
    );
    expect(records.every((r) => r.action.startsWith("sandbox."))).toBe(true);
  });
});

describe("what the operator can do (ADR 0019 §3)", () => {
  it("suspends: every certificate revoked, nothing more created, audited under the operator's id", async () => {
    const owner = await participantWithCertificate();
    const op = await operator();
    const result = await s.admin.suspend(op, owner.organisationId, "abuse of the quota");
    expect(result).toMatchObject({ alreadySuspended: false, revokedCertificates: 1 });
    const detail = await s.admin.organisation(op, owner.organisationId);
    expect(detail.organisation.status).toBe("SUSPENDED");
    expect(detail.certificates.every((c) => c.revokedAt !== null)).toBe(true);
    expect(
      await errorCode(s.sandbox.activeMembershipIn(owner.context, owner.organisationId)),
    ).toBe("sandbox_organisation_suspended");
    const { records } = await s.admin.auditTrail(op, owner.organisationId);
    expect(records.find((r) => r.action === "sandbox.organisation.suspended")?.actor).toBe(
      `sandbox-operator:${op.person.id}`,
    );
  });

  it("revokes a pending invitation, which can then not be accepted", async () => {
    const owner = await participantWithCertificate();
    const { invitationToken } = await s.sandbox.invite(
      owner.context,
      owner.organisationId,
      "member",
      "new@example.test",
    );
    const op = await operator();
    const [pending] = (await s.admin.invitations(op)).invitations;
    await s.admin.revokeInvitation(op, pending?.id as string);
    expect((await s.admin.invitations(op)).invitations).toEqual([]);
    expect(
      await errorCode(
        s.sandbox.createProfile(identity("new@example.test"), {
          displayName: "New",
          invitationToken,
        }),
      ),
    ).toBe("invitation_expired");
    expect(await errorCode(s.admin.revokeInvitation(op, pending?.id as string))).toBe(
      "not_found",
    );
  });

  it("ends a person's sessions at once", async () => {
    const owner = await participantWithCertificate();
    const op = await operator();
    expect(await s.admin.endSessions(op, owner.context.person.id)).toEqual({ ended: 1 });
    expect(await errorCode(s.sandbox.authenticate(owner.sessionToken))).toBe("unauthenticated");
  });
});

describe("privacy (ADR 0018 Decision 5)", () => {
  it("puts no address in an audit record or a log, whatever the operator does", async () => {
    const owner = await participantWithCertificate();
    await s.sandbox.invite(owner.context, owner.organisationId, "member", "new@example.test");
    const op = await operator();
    const [pending] = (await s.admin.invitations(op)).invitations;
    await s.admin.revokeInvitation(op, pending?.id as string);
    await s.admin.endSessions(op, owner.context.person.id);
    await s.admin.suspend(op, owner.organisationId, "testing the audit");
    const { rows } = await harness.handle.pool.query<{ dump: string }>(
      "SELECT coalesce(json_agg(t)::text, '') AS dump FROM audit_events t",
    );
    const logs = harness.logs.lines.join("\n");
    for (const address of [OPERATOR, owner.email, "new@example.test"]) {
      expect(rows[0]?.dump ?? "").not.toContain(address);
      expect(logs).not.toContain(address);
    }
  });
});
