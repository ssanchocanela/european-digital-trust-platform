import { generateKeyPairSync, sign } from "node:crypto";
import { SANDBOX_QUOTAS } from "@edtp/sandbox-domain";
import { issueCertificate, OID, randomSerial } from "@edtp/sandbox-pki";
import { newCorrelationId } from "@edtp/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../support/harness.js";
import { errorCode, person, wireSandbox } from "../support/sandbox.js";

/**
 * Quotas and suspension (S6): what a participant may create before the sandbox is exposed, and what
 * the operator's suspension takes away (specification §8.3, §11 and J9). Real database, fake engine.
 */
let harness: Harness;
let s: Awaited<ReturnType<typeof wireSandbox>>;
let owner: Awaited<ReturnType<Awaited<ReturnType<typeof wireSandbox>>["signUp"]>>;

const SERVICE = {
  description: [{ lang: "en", value: "A test service" }],
  supportUri: "https://org.test/support",
  privacyPolicyUri: "https://org.test/privacy",
  infoUri: "https://org.test",
};

function walletProviderAnchor() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const name = [{ type: OID.commonName, value: "Test Wallet Provider" }];
  const der = issueCertificate(
    {
      serial: randomSerial(),
      issuer: name,
      subject: name,
      notBefore: new Date(0),
      notAfter: new Date(4e12),
      subjectPublicKey: publicKey,
      extensions: [],
    },
    { publicKey, sign: (d) => sign("sha256", d, { key: privateKey, dsaEncoding: "der" }) },
  );
  return { name: "Test Wallet Provider", certificate: der };
}

async function relyingParty(tradeName = "Banco Ejemplo") {
  const service = await s.certificates.createService(owner.context, owner.organisationId, {
    role: "service_provider",
    tradeName,
    ...SERVICE,
  });
  const use = await s.certificates.addIntendedUse(
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
  return { serviceId: service.relyingPartyServiceId, intendedUseId: use.id as string };
}

async function pidProvider(tradeName = "PID Ejemplo") {
  const service = await s.certificates.createService(owner.context, owner.organisationId, {
    role: "pid_provider",
    tradeName,
    ...SERVICE,
  });
  return service.relyingPartyServiceId;
}

const issuer = () => {
  if (!s.issuer) throw new Error("no issuer");
  return s.issuer;
};

const configureVerifier = (serviceId: string, intendedUseId: string) =>
  s.verifier.configure(owner.context, owner.organisationId, serviceId, {
    accessVariant: "AC-00",
    uses: [{ intendedUseId, registrationVariant: "RC-00" }],
  });

const configureIssuer = (serviceId: string) =>
  issuer().configure(owner.context, owner.organisationId, serviceId, {
    signingVariant: "PID-00",
    registrationVariant: "RC-00",
  });

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
  s = await wireSandbox(harness, {
    walletProviderAnchors: [walletProviderAnchor()],
    walletProviderTrustListId: "wallet-providers",
  });
  owner = await s.signUp(person("Ana"), "Ejemplo");
});

describe("engine-tenant quotas", () => {
  it("allows three hosted verifiers, refuses a fourth before creating its engine tenant, and lets an existing one be reconfigured", async () => {
    const rps = [];
    for (let i = 0; i < 4; i++) rps.push(await relyingParty(`Servicio ${i}`));
    for (const rp of rps.slice(0, 3)) await configureVerifier(rp.serviceId, rp.intendedUseId);
    const tenants = s.createdEngineTenants.length;
    const fourth = rps[3] as (typeof rps)[number];
    expect(await errorCode(configureVerifier(fourth.serviceId, fourth.intendedUseId))).toBe(
      "sandbox_quota_exceeded",
    );
    expect(s.createdEngineTenants).toHaveLength(tenants);
    const first = rps[0] as (typeof rps)[number];
    const again = await configureVerifier(first.serviceId, first.intendedUseId);
    expect(again.configured).toBe(true);
  });

  it("allows one hosted issuer and refuses a second, on another PID Provider service", async () => {
    await configureIssuer(await pidProvider("PID Uno"));
    const second = await pidProvider("PID Dos");
    expect(await errorCode(configureIssuer(second))).toBe("sandbox_quota_exceeded");
  });
});

describe("daily and count quotas", () => {
  it("refuses an eleventh service", async () => {
    for (let i = 0; i < SANDBOX_QUOTAS.servicesPerOrganisation; i++) {
      await pidProvider(`PID ${i}`);
    }
    expect(await errorCode(pidProvider("PID de más"))).toBe("sandbox_quota_exceeded");
  });

  it("refuses a certificate past the daily quota of a service, and allows it again 24 hours later", async () => {
    const serviceId = await pidProvider();
    for (let i = 0; i < SANDBOX_QUOTAS.certificatesPerServicePerDay; i++) {
      await s.certificates.issueRegistrationCertificate(
        owner.context,
        owner.organisationId,
        serviceId,
        { variant: "RC-00" },
      );
    }
    const issue = () =>
      s.certificates.issueRegistrationCertificate(
        owner.context,
        owner.organisationId,
        serviceId,
        {
          variant: "RC-00",
        },
      );
    expect(await errorCode(issue())).toBe("sandbox_quota_exceeded");
    harness.clock.advance(86_400_001);
    await expect(issue()).resolves.toBeDefined();
  });
});

describe("suspension by the operator", () => {
  it("revokes every certificate the organisation holds and refuses whatever it would create next", async () => {
    const rp = await relyingParty();
    await configureVerifier(rp.serviceId, rp.intendedUseId);
    const pid = await pidProvider();
    await configureIssuer(pid);
    const organisation = await s.sandbox.organisation(owner.context, owner.organisationId);
    const identifier = organisation.organisation.localIdentifier;

    const result = await s.certificates.suspendOrganisation(identifier, "test of J9");
    expect(result.alreadySuspended).toBe(false);
    expect(result.revokedCertificates).toBeGreaterThanOrEqual(4);
    const held = await harness.deps.repositories.sandboxCertificates.certificates(
      owner.context.memberships[0]?.tenantId as never,
    );
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((c) => c.revokedAt)).toBe(true);

    expect(
      await errorCode(
        s.verifier.startRun(owner.context, owner.organisationId, rp.serviceId, {
          intendedUseId: rp.intendedUseId,
          interaction: "SAME_DEVICE",
          correlationId: newCorrelationId(),
        }),
      ),
    ).toBe("sandbox_organisation_suspended");
    expect(
      await errorCode(
        issuer().offer(owner.context, owner.organisationId, pid, {
          givenName: "Zelda",
          familyName: "Quintanilla",
          birthdate: "1991-02-03",
          birthCountry: "ES",
          nationalities: ["ES"],
        }),
      ),
    ).toBe("sandbox_organisation_suspended");
    expect(await errorCode(pidProvider("PID Tres"))).toBe("sandbox_organisation_suspended");

    const again = await s.certificates.suspendOrganisation(identifier, "twice");
    expect(again).toMatchObject({ alreadySuspended: true, revokedCertificates: 0 });
  });

  it("answers not found for an identifier no organisation has", async () => {
    expect(await errorCode(s.certificates.suspendOrganisation("SB:ES-999999", "none"))).toBe(
      "not_found",
    );
  });
});
