import type { X509Certificate } from "node:crypto";
import { bannedWordsIn, NOT_A_CONFORMANCE_TEST } from "@edtp/sandbox-domain";
import { decodeCompactJws, verifyEs256, x5cCertificates } from "@edtp/sandbox-pki";
import { newCorrelationId } from "@edtp/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../support/harness.js";
import { errorCode, wireSandbox } from "../support/sandbox.js";

/**
 * Wallet test plans (ADR 0022), on a real database with the fake engine: a plan run configures the
 * participant's own hosted verifier or issuer step by step, keeps the server's and the tester's
 * observations apart, flags disagreement, and signs a report that grades nothing.
 */
const SERVICE = {
  description: [{ lang: "en", value: "A test service" }],
  supportUri: "https://org.test/support",
  privacyPolicyUri: "https://org.test/privacy",
  infoUri: "https://org.test",
};
const DECLARED = { provider: "Wallet Co", build: "1.2.3", platform: "Android 15" };

let harness: Harness;
let s: Awaited<ReturnType<typeof wireSandbox>>;
let owner: Awaited<ReturnType<Awaited<ReturnType<typeof wireSandbox>>["signUp"]>>;

async function relyingParty() {
  const service = await s.certificates.createService(owner.context, owner.organisationId, {
    role: "service_provider",
    tradeName: "Banco",
    ...SERVICE,
  });
  await s.certificates.addIntendedUse(
    owner.context,
    owner.organisationId,
    service.relyingPartyServiceId,
    {
      purpose: [{ lang: "en", value: "Identify the customer" }],
      credentials: [
        { format: "dc+sd-jwt", types: ["urn:eudi:pid:1"], claims: [["given_name"]] },
      ],
    },
  );
  return service.relyingPartyServiceId;
}

beforeAll(async () => {
  harness = await createHarness({
    fakeIssuer: true,
    env: { PSEUDONYM_MASTER_KEY: Buffer.alloc(32, 3).toString("base64") },
  });
});
afterAll(async () => {
  await harness?.close();
});
beforeEach(async () => {
  await harness.reset();
  s = await wireSandbox(harness);
  owner = await s.signUp(undefined, "Banco");
});

describe("a plan run on the hosted verifier (ADR 0022 §2–§3)", () => {
  it("configures each step's variants, and reports the server's and the tester's observations apart", async () => {
    const serviceId = await relyingParty();
    const run = await s.walletTests.start(
      owner.context,
      owner.organisationId,
      serviceId,
      "access-certificates",
      DECLARED,
    );

    const step = await s.walletTests.startStep(
      owner.context,
      owner.organisationId,
      run.id,
      1,
      "SAME_DEVICE",
      newCorrelationId(),
    );
    expect(step.walletUri).toBeTruthy();
    const view = await s.verifier.view(owner.context, owner.organisationId, serviceId);
    expect(JSON.stringify(view)).toContain("AC-01");

    // The wallet presented despite the unknown CA, and the tester says it refused.
    harness.verifier.settleLastVerified({ given_name: "Plan" });
    await s.walletTests.observe(
      owner.context,
      owner.organisationId,
      run.id,
      1,
      "refused_before_consent",
      "no prompt shown",
    );

    const report = await s.walletTests.report(
      owner.context,
      owner.organisationId,
      run.id,
      newCorrelationId(),
    );
    expect(report.statement).toBe(NOT_A_CONFORMANCE_TEST);
    expect(report.wallet).toEqual({ ...DECLARED, declared: true });
    expect(report.steps).toHaveLength(7);
    expect(report.steps[1]).toMatchObject({
      started: true,
      server: "presented",
      tester: "refused_before_consent",
      observationsDisagree: true,
    });
    expect(report.steps[0]).toMatchObject({ started: false });
    expect(report.steps[1]?.requirement).toContain("RPA_04");
    expect(bannedWordsIn(JSON.stringify(report))).toEqual([]);
  });

  it("refuses an observation for a step not started, and an observation off the list", async () => {
    const serviceId = await relyingParty();
    const run = await s.walletTests.start(
      owner.context,
      owner.organisationId,
      serviceId,
      "access-certificates",
      DECLARED,
    );
    expect(
      await errorCode(
        s.walletTests.observe(
          owner.context,
          owner.organisationId,
          run.id,
          2,
          "nothing_happened",
          undefined,
        ),
      ),
    ).toBe("wallet_test_step_not_started");
    await s.walletTests.startStep(
      owner.context,
      owner.organisationId,
      run.id,
      2,
      "SAME_DEVICE",
      newCorrelationId(),
    );
    expect(
      await errorCode(
        s.walletTests.observe(
          owner.context,
          owner.organisationId,
          run.id,
          2,
          "it passed",
          undefined,
        ),
      ),
    ).toBe("invalid_observation");
  });

  it("refuses a plan on a service of the wrong role, and one without an intended use", async () => {
    const pid = await s.certificates.createService(owner.context, owner.organisationId, {
      role: "pid_provider",
      tradeName: "PID Co",
      ...SERVICE,
    });
    expect(
      await errorCode(
        s.walletTests.start(
          owner.context,
          owner.organisationId,
          pid.relyingPartyServiceId,
          "access-certificates",
          DECLARED,
        ),
      ),
    ).toBe("wallet_test_plan_not_for_this_service");
    const bare = await s.certificates.createService(owner.context, owner.organisationId, {
      role: "service_provider",
      tradeName: "Bare",
      ...SERVICE,
    });
    const run = await s.walletTests.start(
      owner.context,
      owner.organisationId,
      bare.relyingPartyServiceId,
      "access-certificates",
      DECLARED,
    );
    expect(
      await errorCode(
        s.walletTests.startStep(
          owner.context,
          owner.organisationId,
          run.id,
          0,
          "SAME_DEVICE",
          newCorrelationId(),
        ),
      ),
    ).toBe("wallet_test_needs_intended_use");
  });

  it("answers another organisation's plan run as not found", async () => {
    const serviceId = await relyingParty();
    const run = await s.walletTests.start(
      owner.context,
      owner.organisationId,
      serviceId,
      "access-certificates",
      DECLARED,
    );
    const other = await s.signUp(undefined, "Other");
    expect(
      await errorCode(
        s.walletTests.report(other.context, other.organisationId, run.id, newCorrelationId()),
      ),
    ).toBe("not_found");
    expect(
      await errorCode(
        s.walletTests.report(other.context, owner.organisationId, run.id, newCorrelationId()),
      ),
    ).toBe("not_found");
  });
});

describe("a plan run on the hosted issuer", () => {
  it("makes a synthetic offer under the step's signing variant", async () => {
    const pid = await s.certificates.createService(owner.context, owner.organisationId, {
      role: "pid_provider",
      tradeName: "PID Co",
      ...SERVICE,
    });
    const run = await s.walletTests.start(
      owner.context,
      owner.organisationId,
      pid.relyingPartyServiceId,
      "issuance",
      DECLARED,
    );
    const step = await s.walletTests.startStep(
      owner.context,
      owner.organisationId,
      run.id,
      1,
      "QR",
      newCorrelationId(),
    );
    expect(step.walletUri).toMatch(/^openid-credential-offer:/);
    const report = await s.walletTests.report(
      owner.context,
      owner.organisationId,
      run.id,
      newCorrelationId(),
    );
    expect(report.steps[1]).toMatchObject({ started: true, server: "pending" });
    expect(report.steps[1]?.title).toContain("PID-01");
  });
  it("runs the EAA plan on an EAA Provider's issuer, with the sandbox's test type (ADR 0023 §7)", async () => {
    const eaa = await s.certificates.createService(owner.context, owner.organisationId, {
      role: "eaa_provider",
      tradeName: "EAA Co",
      ...SERVICE,
    });
    const serviceId = eaa.relyingPartyServiceId;
    expect(
      await errorCode(
        s.walletTests.start(
          owner.context,
          owner.organisationId,
          serviceId,
          "issuance",
          DECLARED,
        ),
      ),
    ).toBe("wallet_test_plan_not_for_this_service");
    const run = await s.walletTests.start(
      owner.context,
      owner.organisationId,
      serviceId,
      "eaa-issuance",
      DECLARED,
    );
    for (const index of [0, 2]) {
      const step = await s.walletTests.startStep(
        owner.context,
        owner.organisationId,
        run.id,
        index,
        "QR",
        newCorrelationId(),
      );
      expect(step.walletUri).toMatch(/^openid-credential-offer:/);
    }
    // The test type was created once, and reused.
    const types = await s.credentialTypes.list(owner.context, owner.organisationId, serviceId);
    expect(types.map((t) => [t.slug, t.versions.length])).toEqual([["edtp-wallet-test", 1]]);
    const report = await s.walletTests.report(
      owner.context,
      owner.organisationId,
      run.id,
      newCorrelationId(),
    );
    expect(report.steps[2]?.title).toContain("EAA-02");
    expect(report.steps[2]?.requirement).toContain("AS-AP-10-010");
  });
});

describe("the signed report (ADR 0022 §4)", () => {
  it("is a JWS from the sandbox's report signer, which says nothing about the wallet", async () => {
    const serviceId = await relyingParty();
    const run = await s.walletTests.start(
      owner.context,
      owner.organisationId,
      serviceId,
      "access-certificates",
      DECLARED,
    );
    const jws = await s.walletTests.signedReport(
      owner.context,
      owner.organisationId,
      run.id,
      newCorrelationId(),
    );
    const decoded = decodeCompactJws(jws);
    expect(decoded.header.typ).toBe("edtp-wallet-test-report+jwt");
    const leaf = x5cCertificates(decoded.header)[0] as X509Certificate;
    expect(verifyEs256(decoded, leaf.publicKey)).toBe(true);
    expect(leaf.subject).toContain("Wallet Test Report Signer - TEST ONLY");
    expect((decoded.payload as { statement: string }).statement).toBe(NOT_A_CONFORMANCE_TEST);
    // The same signer the second time: the key and its certificate are kept.
    const again = decodeCompactJws(
      await s.walletTests.signedReport(
        owner.context,
        owner.organisationId,
        run.id,
        newCorrelationId(),
      ),
    );
    expect((x5cCertificates(again.header)[0] as X509Certificate).fingerprint256).toBe(
      leaf.fingerprint256,
    );
  });
});
