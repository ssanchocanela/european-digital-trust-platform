import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../support/harness.js";
import { errorCode, identity, wireSandbox } from "../support/sandbox.js";

/**
 * Erasure of a person (ADR 0021), on a real database: what goes, what stays, the last-owner rule,
 * and the operator's override — with no address left in the database or the audit trail.
 */
const OPERATOR = "op@example.test";
const SERVICE = {
  description: [{ lang: "en", value: "A test service" }],
  supportUri: "https://org.test/support",
  privacyPolicyUri: "https://org.test/privacy",
  infoUri: "https://org.test",
};

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

async function join2(
  owner: Awaited<ReturnType<typeof s.signUp>>,
  email: string,
  role: "owner" | "member" = "member",
) {
  const { invitationToken } = await s.sandbox.invite(
    owner.context,
    owner.organisationId,
    role,
    email,
  );
  const done = await s.sandbox.createProfile(identity(email), {
    displayName: email.split("@")[0] as string,
    invitationToken,
  });
  return {
    sessionToken: done.sessionToken,
    context: await s.sandbox.authenticate(done.sessionToken),
  };
}

async function operator() {
  const done = await s.sandbox.createProfile(identity(OPERATOR), { displayName: "Operator" });
  return s.sandbox.authenticate(done.sessionToken);
}

async function dump(): Promise<string> {
  const { rows } = await harness.handle.pool.query<{ dump: string }>(
    `SELECT concat_ws('|',
       (SELECT coalesce(json_agg(t)::text, '') FROM sandbox_people t),
       (SELECT coalesce(json_agg(t)::text, '') FROM sandbox_invitations t),
       (SELECT coalesce(json_agg(t)::text, '') FROM sandbox_memberships t),
       (SELECT coalesce(json_agg(t)::text, '') FROM sandbox_sessions t),
       (SELECT coalesce(json_agg(t)::text, '') FROM audit_events t)) AS dump`,
  );
  return rows[0]?.dump ?? "";
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

describe("a person deletes their own account (ADR 0021 §1–§2)", () => {
  it("erases the person, their memberships and sessions, and every invitation to or from them", async () => {
    const owner = await s.signUp(undefined, "Banco");
    const bruno = await join2(owner, "bruno@example.test");
    // An owner, so the invitation Bruno creates is his to lose; the owner keeps one owner too.
    await s.sandbox.makeOwner(owner.context, owner.organisationId, bruno.context.person.id);
    const brunoAsOwner = await s.sandbox.authenticate(bruno.sessionToken);
    await s.sandbox.invite(brunoAsOwner, owner.organisationId, "member", "x@example.test");
    await s.sandbox.invite(owner.context, owner.organisationId, "member", "bruno@example.test");
    expect(await dump()).toContain("bruno@example.test");
    expect(await dump()).toContain("x@example.test");

    const result = await s.erasure.eraseSelf(brunoAsOwner, " Bruno@Example.TEST ");
    expect(result).toEqual({ erased: true, suspended: [] });
    expect(await dump()).not.toContain("bruno@example.test");
    // The invitation Bruno created went with him (ADR 0021 §2).
    expect(await dump()).not.toContain("x@example.test");
    expect(await errorCode(s.sandbox.authenticate(bruno.sessionToken))).toBe("unauthenticated");
    expect(
      (await s.sandbox.members(owner.context, owner.organisationId)).map((m) => m.email),
    ).toEqual([owner.email]);

    const { rows } = await harness.handle.pool.query<{ actor: string; subject_id: string }>(
      "SELECT actor, subject_id FROM audit_events WHERE action = 'sandbox.person.erased'",
    );
    expect(rows).toEqual([{ actor: "sandbox", subject_id: bruno.context.person.id }]);
  });

  it("asks for the person's own address to confirm", async () => {
    const owner = await s.signUp(undefined, "Banco");
    expect(await errorCode(s.erasure.eraseSelf(owner.context, "someone@else.test"))).toBe(
      "erasure_confirmation_mismatch",
    );
  });

  it("comes back as a stranger", async () => {
    const owner = await s.signUp(undefined, "Banco");
    await s.erasure.eraseSelf(owner.context, owner.email);
    expect(await s.sandbox.enter(identity(owner.email))).toEqual({
      outcome: "needs_profile",
      email: owner.email,
    });
  });
});

describe("the last owner (ADR 0021 §3–§4)", () => {
  it("suspends an organisation whose only member leaves, and revokes its certificates", async () => {
    const owner = await s.signUp(undefined, "Solo");
    const service = await s.certificates.createService(owner.context, owner.organisationId, {
      role: "service_provider",
      tradeName: "Solo RP",
      ...SERVICE,
    });
    await s.certificates.issueAccessCertificate(
      owner.context,
      owner.organisationId,
      service.relyingPartyServiceId,
      {
        variant: "AC-00",
        csrPem: csr(),
        dnsNames: ["rp.example.test"],
      },
    );
    const preview = await s.erasure.previewSelf(owner.context);
    expect(preview.organisations).toEqual([
      expect.objectContaining({ members: 1, effect: "suspended" }),
    ]);
    const result = await s.erasure.eraseSelf(owner.context, owner.email);
    expect(result.suspended).toHaveLength(1);
    const org = await harness.deps.repositories.sandbox.findOrganisation(owner.organisationId);
    expect(org?.status).toBe("SUSPENDED");
    const certs = await harness.deps.repositories.sandboxCertificates.certificates(
      owner.organisationId,
    );
    expect(certs.every((c) => c.revokedAt)).toBe(true);
  });

  it("refuses the last owner of an organisation with other members, until another is made owner", async () => {
    const owner = await s.signUp(undefined, "Banco");
    const bruno = await join2(owner, "bruno@example.test");
    expect((await s.erasure.previewSelf(owner.context)).allowed).toBe(false);
    expect(await errorCode(s.erasure.eraseSelf(owner.context, owner.email))).toBe(
      "sandbox_last_owner",
    );

    await s.sandbox.makeOwner(owner.context, owner.organisationId, bruno.context.person.id);
    await s.erasure.eraseSelf(owner.context, owner.email);
    const org = await harness.deps.repositories.sandbox.findOrganisation(owner.organisationId);
    expect(org?.status).toBe("ACTIVE");
    const remaining = await s.sandbox.members(bruno.context, owner.organisationId);
    expect(remaining).toEqual([
      expect.objectContaining({ email: "bruno@example.test", role: "owner" }),
    ]);
  });

  it("lets only an owner make another member an owner", async () => {
    const owner = await s.signUp(undefined, "Banco");
    const bruno = await join2(owner, "bruno@example.test");
    const carla = await join2(owner, "carla@example.test");
    expect(
      await errorCode(
        s.sandbox.makeOwner(bruno.context, owner.organisationId, carla.context.person.id),
      ),
    ).toBe("sandbox_owner_required");
  });
});

describe("the operator erases a person (ADR 0021 §1, §3)", () => {
  it("is not found for anyone else, refuses a last owner without override, and suspends with it", async () => {
    const owner = await s.signUp(undefined, "Banco");
    const bruno = await join2(owner, "bruno@example.test");
    expect(
      await errorCode(
        s.erasure.eraseByOperator(bruno.context, owner.context.person.id, "x", true),
      ),
    ).toBe("not_found");
    const op = await operator();
    expect(
      await errorCode(
        s.erasure.eraseByOperator(op, owner.context.person.id, "on request", false),
      ),
    ).toBe("sandbox_last_owner");
    const preview = await s.erasure.previewByOperator(op, owner.context.person.id, true);
    expect(preview.organisations).toEqual([expect.objectContaining({ effect: "suspended" })]);
    await s.erasure.eraseByOperator(
      op,
      owner.context.person.id,
      "erasure request by e-mail",
      true,
    );
    const org = await harness.deps.repositories.sandbox.findOrganisation(owner.organisationId);
    expect(org?.status).toBe("SUSPENDED");
    const { rows } = await harness.handle.pool.query<{ actor: string }>(
      "SELECT actor FROM audit_events WHERE action = 'sandbox.person.erased'",
    );
    expect(rows[0]?.actor).toBe(`sandbox-operator:${op.person.id}`);
    expect(await dump()).not.toContain(owner.email);
  });

  it("does not erase the operator through the operator's section", async () => {
    const op = await operator();
    expect(await errorCode(s.erasure.eraseByOperator(op, op.person.id, "self", false))).toBe(
      "erasure_of_self_by_operator",
    );
  });
});
