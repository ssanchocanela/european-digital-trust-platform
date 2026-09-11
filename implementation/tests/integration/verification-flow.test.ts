import { newCorrelationId, PlatformError } from "@edtp/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../support/harness.js";
import { type SeededTenant, seedTenant } from "../support/seed.js";

/**
 * The Verification-as-a-Service flow, end to end through the business layer.
 *
 * Real repositories, real PostgreSQL, real services, the checked-in migrations — and a
 * **fake verifier port**. That is the "business layer with mocked ports, without EUDIPLO"
 * suite the V0 plan asks for: every layer the platform owns runs for real, and only the
 * wrapped engine is substituted.
 */
let harness: Harness;
let seeded: SeededTenant;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  // Guarded: if `beforeAll` failed, the harness is undefined and an unguarded close would
  // mask the real cause with a TypeError.
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  seeded = await seedTenant(harness);
});

const correlationId = () => newCorrelationId();

describe("the V0 end-to-end target", () => {
  it("runs Tenant → … → Policy → presentation → verified result", async () => {
    const { presentations } = harness.deps.services;

    const created = await presentations.create({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      businessReference: "order-4711",
      correlationId: correlationId(),
    });

    expect(created.status).toBe("AWAITING_WALLET");
    // SAME_DEVICE is the tested V0 path — ADR 0005 Decision 6.
    expect(created.interaction?.type).toBe("SAME_DEVICE");
    expect(created.interaction?.uri).toMatch(/^openid4vp:\/\//);
    expect(created.policyVersion).toBe(1);

    // The plan the adapter received carries the registered identifiers and no protocol
    // structure.
    const plan = harness.verifier.createdPlans[0];
    expect(plan?.relyingPartyContext.serviceIdentifier).toBe("age-gate");
    expect(plan?.relyingPartyContext.engineTenantRef).toBe("engine-tenant-a");
    expect(plan?.requestedClaims).toEqual([{ path: ["birthdate"] }]);

    // The wallet presents a PID disclosing the date of birth.
    harness.verifier.settleVerified("engine-session-1", { birthdate: "1990-05-17" });

    const settled = await presentations.get(
      seeded.tenantId,
      created.presentationId,
      correlationId(),
    );

    expect(settled.status).toBe("VERIFIED");
    // The derived boolean only. ADR 0005 Decision 5: derivation is the primary route for an
    // age check because `age_over_18` is no longer a PID attribute.
    expect(settled.result?.claims).toEqual({ over_18: true });
  });

  it("never persists the source date of birth anywhere", async () => {
    const { presentations } = harness.deps.services;
    const created = await presentations.create({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      businessReference: "order-privacy",
      correlationId: correlationId(),
    });
    harness.verifier.settleVerified("engine-session-1", {
      birthdate: "1990-05-17",
      given_name: "Jan",
      _sd: ["hash-a", "hash-b"],
    });
    await presentations.get(seeded.tenantId, created.presentationId, correlationId());

    // The decisive assertion for ADR 0004: scan every table for the disclosed values. The
    // platform has no table for content, so there must be nowhere for them to be.
    const { rows } = await harness.handle.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    for (const { table_name } of rows) {
      const dump = await harness.handle.pool.query(
        `SELECT to_jsonb(t)::text AS row FROM "${table_name}" t`,
      );
      const serialised = dump.rows.map((r) => (r as { row: string }).row).join("\n");
      expect(serialised, `${table_name} contains the date of birth`).not.toContain(
        "1990-05-17",
      );
      expect(serialised, `${table_name} contains a disclosed name`).not.toContain("Jan");
      expect(serialised, `${table_name} contains an SD hash`).not.toContain("hash-a");
    }
  });

  it("never writes the source value to a log line", async () => {
    const { presentations } = harness.deps.services;
    const created = await presentations.create({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      businessReference: "order-logs",
      correlationId: correlationId(),
    });
    harness.verifier.settleVerified("engine-session-1", { birthdate: "1990-05-17" });
    await presentations.get(seeded.tenantId, created.presentationId, correlationId());

    const allLogs = harness.logs.lines.join("\n");
    expect(allLogs).not.toContain("1990-05-17");
    // The safe identifiers are present, so the absence above is not simply an empty log.
    expect(allLogs).toContain(created.presentationId);
  });

  it("records every state transition, including the inferred intermediate ones", async () => {
    const { presentations } = harness.deps.services;
    const created = await presentations.create({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      businessReference: "order-audit",
      correlationId: correlationId(),
    });
    harness.verifier.settleVerified("engine-session-1", { birthdate: "1990-05-17" });
    await presentations.get(seeded.tenantId, created.presentationId, correlationId());

    const transitions = await harness.deps.repositories.transactions.listTransitions(
      created.presentationId,
    );
    const states = transitions.map((t) => t.toState);
    // The engine reports a coarse status, so the platform walks the intermediate states
    // explicitly rather than jumping the state machine.
    expect(states).toEqual([
      "CREATED",
      "REQUEST_READY",
      "AWAITING_WALLET",
      "PRESENTATION_RECEIVED",
      "VERIFYING",
      "VERIFIED",
    ]);
  });

  it("reports that the request went without a registration certificate", async () => {
    // `EW-DM-44-023` (`RPRC_19`) requires one by value. V0 has no reachable provider
    // (blocker B3), so the omission must be visible rather than silent.
    const { presentations } = harness.deps.services;
    const created = await presentations.create({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      businessReference: "order-no-rprc",
      correlationId: correlationId(),
    });
    expect(created.sentWithoutRegistrationCertificate).toBe(true);

    const { rows } = await harness.handle.pool.query<{ flag: boolean }>(
      'SELECT "sent_without_registration_certificate" AS flag FROM "presentation_transactions" WHERE id = $1',
      [created.presentationId],
    );
    expect(rows[0]?.flag).toBe(true);
  });

  it("attaches the registration certificate when one is available", async () => {
    await harness.reset();
    const withCert = await seedTenant(harness, {
      registrationCertificateJwt: "eyJhbGciOiJFUzI1NiJ9.e30.sig",
    });
    const created = await harness.deps.services.presentations.create({
      tenantId: withCert.tenantId,
      policyId: withCert.policyId,
      businessReference: "order-rprc",
      correlationId: correlationId(),
    });
    expect(created.sentWithoutRegistrationCertificate).toBe(false);
    expect(
      harness.verifier.createdPlans[0]?.relyingPartyContext.registrationCertificateJwt,
    ).toBe("eyJhbGciOiJFUzI1NiJ9.e30.sig");
  });
});

describe("terminal outcomes", () => {
  const settleWith = async (
    outcome: Parameters<typeof harness.verifier.settleAs>[1],
    failureCode?: string,
  ) => {
    const created = await harness.deps.services.presentations.create({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      businessReference: `order-${outcome}`,
      correlationId: correlationId(),
    });
    harness.verifier.settleAs("engine-session-1", outcome, failureCode);
    return harness.deps.services.presentations.get(
      seeded.tenantId,
      created.presentationId,
      correlationId(),
    );
  };

  it("maps a credential defect to REJECTED and keeps the failure code", async () => {
    const view = await settleWith("REJECTED", "signature_invalid");
    expect(view.status).toBe("REJECTED");
    expect(view.failureCode).toBe("signature_invalid");
    expect(view.result).toBeUndefined();
  });

  it("maps a trust failure to TRUST_ERROR", async () => {
    const view = await settleWith("TRUST_ERROR", "trust_chain_not_trusted");
    expect(view.status).toBe("TRUST_ERROR");
  });

  it("maps a wallet denial to DECLINED_BY_USER", async () => {
    const view = await settleWith("DECLINED_BY_USER", "access_denied");
    expect(view.status).toBe("DECLINED_BY_USER");
  });

  it("settles POLICY_NOT_SATISFIED when the source claim was not disclosed", async () => {
    const { presentations } = harness.deps.services;
    const created = await presentations.create({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      businessReference: "order-unsatisfied",
      correlationId: correlationId(),
    });
    // The engine verified the presentation, but the wallet disclosed nothing the derivation
    // can use — a valid presentation that does not satisfy the policy.
    harness.verifier.settleVerified("engine-session-1", { given_name: "Jan" });

    const view = await presentations.get(
      seeded.tenantId,
      created.presentationId,
      correlationId(),
    );
    expect(view.status).toBe("POLICY_NOT_SATISFIED");
    expect(view.result).toBeUndefined();
  });

  it("logs a verifier-side trust failure as our own operational failure", async () => {
    const { presentations } = harness.deps.services;
    const created = await presentations.create({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      businessReference: "order-verifier-side",
      correlationId: correlationId(),
    });
    harness.verifier.settleVerifierSideFailure("engine-session-1");

    const view = await presentations.get(
      seeded.tenantId,
      created.presentationId,
      correlationId(),
    );
    expect(view.status).toBe("TRUST_ERROR");
    // The engine documents `trust_list_unavailable` as a verifier-side misconfiguration or
    // outage, not a defect in the presented credential.
    expect(harness.logs.lines.join("\n")).toContain("verifier-side trust failure");
  });

  it("cancels a transaction that is still awaiting the wallet", async () => {
    const { presentations } = harness.deps.services;
    const created = await presentations.create({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      businessReference: "order-cancel",
      correlationId: correlationId(),
    });

    const cancelled = await presentations.cancel(
      seeded.tenantId,
      created.presentationId,
      correlationId(),
    );
    expect(cancelled.status).toBe("CANCELLED");
    // Cancelling also removes the engine session, which is the earliest point any content it
    // holds disappears.
    expect(harness.verifier.cancelled).toContain("engine-session-1");
  });

  it("refuses to cancel a settled transaction", async () => {
    const { presentations } = harness.deps.services;
    const created = await presentations.create({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      businessReference: "order-cancel-late",
      correlationId: correlationId(),
    });
    harness.verifier.settleVerified("engine-session-1", { birthdate: "1990-05-17" });
    await presentations.get(seeded.tenantId, created.presentationId, correlationId());

    await expect(
      presentations.cancel(seeded.tenantId, created.presentationId, correlationId()),
    ).rejects.toMatchObject({ code: "presentation_already_settled" });
  });

  it("expires a transaction whose lifetime has elapsed", async () => {
    const { presentations } = harness.deps.services;
    const created = await presentations.create({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      businessReference: "order-expire",
      correlationId: correlationId(),
    });

    // The lifetime is the platform's promise to the customer, so it holds whatever the
    // engine says.
    harness.clock.advance(301_000);

    const view = await presentations.get(
      seeded.tenantId,
      created.presentationId,
      correlationId(),
    );
    expect(view.status).toBe("EXPIRED");
  });

  it("settles PROTOCOL_ERROR and surfaces the failure when the engine refuses the request", async () => {
    const { presentations } = harness.deps.services;
    harness.verifier.failNextCreate(
      PlatformError.engine("engine_unavailable", "The engine is unavailable."),
    );

    await expect(
      presentations.create({
        tenantId: seeded.tenantId,
        policyId: seeded.policyId,
        businessReference: "order-engine-down",
        correlationId: correlationId(),
      }),
    ).rejects.toMatchObject({ code: "engine_unavailable" });

    // The transaction still exists and is closed, rather than being left dangling.
    const { rows } = await harness.handle.pool.query<{ state: string }>(
      'SELECT state FROM "presentation_transactions" WHERE business_reference = $1',
      ["order-engine-down"],
    );
    expect(rows[0]?.state).toBe("PROTOCOL_ERROR");
  });
});

describe("the engine session window", () => {
  it("is sized to the transaction lifetime and set before the session is created", async () => {
    await harness.deps.services.presentations.create({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      businessReference: "order-ttl",
      correlationId: correlationId(),
    });

    // ADR 0004 makes this mandatory: the engine's own default retains disclosed claims for
    // 24 hours, so no session may ever be created under it.
    const calls = harness.verifier.retentionCalls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const last = calls[calls.length - 1];
    expect(last?.settings.sessionTtlSeconds).toBe(300);
    expect(last?.settings.cleanupMode).toBe("ANONYMIZE");
  });
});
