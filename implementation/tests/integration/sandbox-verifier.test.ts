import { newCorrelationId } from "@edtp/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../support/harness.js";
import { errorCode, person, VERIFIER_DNS, wireSandbox } from "../support/sandbox.js";

/** The hosted verifier and its run reports, on a real database with the fake engine (S4). */
let harness: Harness;
let s: Awaited<ReturnType<typeof wireSandbox>>;
let owner: Awaited<ReturnType<Awaited<ReturnType<typeof wireSandbox>>["signUp"]>>;

const SERVICE = {
  tradeName: "Banco Ejemplo Onboarding",
  description: [{ lang: "en", value: "Account opening" }],
  supportUri: "https://banco.test/support",
  privacyPolicyUri: "https://banco.test/privacy",
  infoUri: "https://banco.test",
};
const claims = [["given_name"], ["family_name"]];

async function relyingParty() {
  const service = await s.certificates.createService(owner.context, owner.organisationId, {
    role: "service_provider",
    ...SERVICE,
  });
  const use = await s.certificates.addIntendedUse(
    owner.context,
    owner.organisationId,
    service.relyingPartyServiceId,
    {
      purpose: [{ lang: "en", value: "Identify the customer" }],
      credentials: [{ format: "dc+sd-jwt", types: ["urn:eudi:pid:1"], claims }],
    },
  );
  return { serviceId: service.relyingPartyServiceId, intendedUseId: use.id as string };
}

const lastPlan = () => {
  const request = harness.verifier.createdRequests.at(-1);
  if (!request) throw new Error("no request");
  return request;
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
  s = await wireSandbox(harness);
  owner = await s.signUp(person("Ana"), "Banco Ejemplo");
});

describe("configuring the hosted verifier", () => {
  it("creates an engine tenant with the PID list, a hosted access certificate and the registration certificate", async () => {
    const { serviceId, intendedUseId } = await relyingParty();
    const view = await s.verifier.configure(owner.context, owner.organisationId, serviceId, {
      accessVariant: "AC-00",
      uses: [{ intendedUseId, registrationVariant: "RC-00" }],
    });
    expect(view.configured).toBe(true);
    expect(s.createdEngineTenants).toHaveLength(1);
    const ref = s.createdEngineTenants[0] as string;
    expect(harness.verifier.trustListKeys).toEqual([ref]);
    expect(harness.verifier.trustLists).toEqual([
      { engineTenantRef: ref, listId: "sbx-pid-providers", issuers: 1 },
    ]);
    // The operator's own instance imported one before; this tenant has exactly one.
    expect(harness.verifier.imports.filter((i) => i.engineTenantRef === ref)).toHaveLength(1);
    if (!view.configured) return;
    expect(view.accessCertificate.mode).toBe("hosted");
    expect(view.accessCertificate.dnsNames).toEqual([VERIFIER_DNS]);
    expect(view.accessCertificate.selfTest).toMatchObject({ fails: [], asDesigned: true });
  });

  it("refuses a PID Provider service, and refuses without runtime engine tenants", async () => {
    const pid = await s.certificates.createService(owner.context, owner.organisationId, {
      role: "pid_provider",
      ...SERVICE,
    });
    expect(
      await errorCode(
        s.verifier.configure(owner.context, owner.organisationId, pid.relyingPartyServiceId, {
          accessVariant: "AC-00",
          uses: [],
        }),
      ),
    ).toBe("sandbox_not_a_relying_party");
    await harness.reset();
    s = await wireSandbox(harness, { withoutEngineTenants: true });
    owner = await s.signUp(person("Ana"), "Banco Ejemplo");
    const { serviceId, intendedUseId } = await relyingParty();
    expect(
      await errorCode(
        s.verifier.configure(owner.context, owner.organisationId, serviceId, {
          accessVariant: "AC-00",
          uses: [{ intendedUseId, registrationVariant: "RC-00" }],
        }),
      ),
    ).toBe("sandbox_engine_tenants_unavailable");
  });
});

describe("runs", () => {
  it("sends the chosen certificates, returns the wallet to the run, and reports presence only", async () => {
    const { serviceId, intendedUseId } = await relyingParty();
    const before = harness.verifier.imports.length;
    const configured = await s.verifier.configure(
      owner.context,
      owner.organisationId,
      serviceId,
      {
        accessVariant: "AC-00",
        uses: [{ intendedUseId, registrationVariant: "RC-00" }],
      },
    );
    const run = await s.verifier.startRun(owner.context, owner.organisationId, serviceId, {
      intendedUseId,
      interaction: "SAME_DEVICE",
      correlationId: newCorrelationId(),
    });
    const plan = lastPlan().plan;
    if (!configured.configured) throw new Error("not configured");
    expect(plan.relyingPartyContext.registrationCertificateJwt).toBe(
      configured.uses[0]?.registrationCertificate.body,
    );
    expect(plan.relyingPartyContext.accessKeyBindingRef).toBe(`key-chain-${before + 1}`);

    harness.verifier.settleLastVerified({ given_name: "Ana", family_name: "Ejemplo" });
    const report = await s.verifier.run(
      owner.context,
      owner.organisationId,
      run.runId,
      newCorrelationId(),
    );
    expect(report.outcome.status).toBe("VERIFIED");
    expect(report.outcome.claimsPresent).toEqual({
      present_given_name: true,
      present_family_name: true,
    });
    expect(JSON.stringify(report)).not.toContain('Ejemplo"');
    expect(report.expected.access.variant).toBe("AC-00");
  });

  it("swaps in defective certificates: an expired access certificate and no registration certificate are sent anyway", async () => {
    const { serviceId, intendedUseId } = await relyingParty();
    const before = harness.verifier.imports.length;
    await s.verifier.configure(owner.context, owner.organisationId, serviceId, {
      accessVariant: "AC-00",
      uses: [{ intendedUseId, registrationVariant: "RC-00" }],
    });
    await s.verifier.configure(owner.context, owner.organisationId, serviceId, {
      accessVariant: "AC-02",
      uses: [{ intendedUseId, registrationVariant: "RC-01" }],
    });
    expect(s.createdEngineTenants).toHaveLength(1);
    await s.verifier.startRun(owner.context, owner.organisationId, serviceId, {
      intendedUseId,
      interaction: "SAME_DEVICE",
      correlationId: newCorrelationId(),
    });
    const plan = lastPlan().plan;
    expect(plan.relyingPartyContext.accessKeyBindingRef).toBe(`key-chain-${before + 2}`);
    expect(plan.relyingPartyContext.registrationCertificateJwt).toBeUndefined();
  });

  it("sends an expired registration certificate (RC-05) rather than refusing", async () => {
    const { serviceId, intendedUseId } = await relyingParty();
    await s.verifier.configure(owner.context, owner.organisationId, serviceId, {
      accessVariant: "AC-00",
      uses: [{ intendedUseId, registrationVariant: "RC-05" }],
    });
    await s.verifier.startRun(owner.context, owner.organisationId, serviceId, {
      intendedUseId,
      interaction: "SAME_DEVICE",
      correlationId: newCorrelationId(),
    });
    expect(lastPlan().plan.relyingPartyContext.registrationCertificateJwt).toBeDefined();
  });

  it("registers no return for a cross-device run", async () => {
    const { serviceId, intendedUseId } = await relyingParty();
    await s.verifier.configure(owner.context, owner.organisationId, serviceId, {
      accessVariant: "AC-00",
      uses: [{ intendedUseId, registrationVariant: "RC-00" }],
    });
    const run = await s.verifier.startRun(owner.context, owner.organisationId, serviceId, {
      intendedUseId,
      interaction: "QR",
      correlationId: newCorrelationId(),
    });
    expect(run.interaction).toBe("QR");
    expect(lastPlan().returnUrl).toBeUndefined();
  });

  it("refuses a run before the verifier is configured", async () => {
    const { serviceId, intendedUseId } = await relyingParty();
    expect(
      await errorCode(
        s.verifier.startRun(owner.context, owner.organisationId, serviceId, {
          intendedUseId,
          interaction: "SAME_DEVICE",
          correlationId: newCorrelationId(),
        }),
      ),
    ).toBe("sandbox_verifier_not_configured");
  });

  it("records the tester's observation, and keeps other organisations out", async () => {
    const { serviceId, intendedUseId } = await relyingParty();
    await s.verifier.configure(owner.context, owner.organisationId, serviceId, {
      accessVariant: "AC-00",
      uses: [{ intendedUseId, registrationVariant: "RC-06" }],
    });
    const run = await s.verifier.startRun(owner.context, owner.organisationId, serviceId, {
      intendedUseId,
      interaction: "SAME_DEVICE",
      correlationId: newCorrelationId(),
    });
    await s.verifier.observe(owner.context, owner.organisationId, run.runId, {
      walletBuild: "EDTP sandbox build S1",
      checkRegistrationCertificates: "on",
      observation: "warned_user_continued",
      note: "Warning about the registration certificate, continued.",
    });
    const report = await s.verifier.run(
      owner.context,
      owner.organisationId,
      run.runId,
      newCorrelationId(),
    );
    expect(report.observation).toMatchObject({
      walletBuild: "EDTP sandbox build S1",
      checkRegistrationCertificates: "on",
      observation: "warned_user_continued",
    });
    expect(report.expected.registration).toMatchObject({
      variant: "RC-06",
      registrationCheck: true,
    });

    const other = await s.signUp(person("Bruno", "1985-12-24"), "Otra");
    expect(
      await errorCode(
        s.verifier.run(other.context, owner.organisationId, run.runId, newCorrelationId()),
      ),
    ).toBe("not_found");
    expect(
      await errorCode(
        s.verifier.run(other.context, other.organisationId, run.runId, newCorrelationId()),
      ),
    ).toBe("not_found");
  });
});
