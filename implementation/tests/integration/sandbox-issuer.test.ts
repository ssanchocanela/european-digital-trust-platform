import { generateKeyPairSync, sign, X509Certificate } from "node:crypto";
import { issueCertificate, OID, randomSerial } from "@edtp/sandbox-pki";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../support/harness.js";
import { errorCode, person, wireSandbox } from "../support/sandbox.js";

/** The hosted PID issuer and its synthetic issuances, on a real database with fake engine ports (S5). */
let harness: Harness;
let s: Awaited<ReturnType<typeof wireSandbox>>;
let owner: Awaited<ReturnType<Awaited<ReturnType<typeof wireSandbox>>["signUp"]>>;

const SERVICE = {
  tradeName: "PID Ejemplo",
  description: [{ lang: "en", value: "A test PID Provider" }],
  supportUri: "https://pid.test/support",
  privacyPolicyUri: "https://pid.test/privacy",
  infoUri: "https://pid.test",
};
const VALUES = {
  givenName: "Zelda",
  familyName: "Quintanilla",
  birthdate: "1991-02-03",
  birthCountry: "ES",
  nationalities: ["ES"],
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

async function pidProvider() {
  const service = await s.certificates.createService(owner.context, owner.organisationId, {
    role: "pid_provider",
    ...SERVICE,
  });
  return service.relyingPartyServiceId;
}

const issuer = () => {
  if (!s.issuer) throw new Error("no issuer");
  return s.issuer;
};

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
  owner = await s.signUp(person("Ana"), "PID Ejemplo");
});

describe("configuring the hosted issuer", () => {
  it("creates an engine tenant with the Wallet Provider list, a signing certificate under the sandbox PID CA, and the provider", async () => {
    const serviceId = await pidProvider();
    const view = await issuer().configure(owner.context, owner.organisationId, serviceId, {
      signingVariant: "PID-00",
      registrationVariant: "RC-00",
    });
    expect(view.configured).toBe(true);
    const ref = s.createdEngineTenants[0] as string;
    expect(ref).toMatch(/^sbx-iss-/);
    expect(harness.verifier.trustLists).toEqual([
      {
        engineTenantRef: ref,
        listId: "wallet-providers",
        issuers: 1,
        providerType: "wallet-provider",
      },
    ]);
    expect(harness.issuer?.signingImports).toEqual([{ engineTenantRef: ref, chainLength: 2 }]);
    expect(harness.issuer?.provisioned.at(-1)).toMatchObject({
      engineTenantRef: ref,
      signingKeyBindingRef: "signing-key-1",
      registrationCertificate: true,
    });
    if (!view.configured) return;
    const x = new X509Certificate(view.signingCertificate.body as string);
    expect(x.checkIssued(s.domain.x509("pid-ca"))).toBe(true);
    expect(view.registrationCertificate.selfTest).toMatchObject({ asDesigned: true });
  });

  it("swaps in an expired signing certificate (PID-02) and provisions it rather than refusing", async () => {
    const serviceId = await pidProvider();
    await issuer().configure(owner.context, owner.organisationId, serviceId, {
      signingVariant: "PID-00",
      registrationVariant: "RC-00",
    });
    await issuer().configure(owner.context, owner.organisationId, serviceId, {
      signingVariant: "PID-02",
      registrationVariant: "RC-05",
    });
    expect(s.createdEngineTenants).toHaveLength(1);
    expect(harness.issuer?.provisioned.at(-1)?.signingKeyBindingRef).toBe("signing-key-2");
    const offer = await issuer().offer(owner.context, owner.organisationId, serviceId, VALUES);
    expect(offer.offerUri).toMatch(/^openid-credential-offer:/);
  });

  it("refuses Relying Party variants, a Relying Party service, and a missing Wallet Provider list", async () => {
    const serviceId = await pidProvider();
    for (const variant of ["RC-08", "RC-01"] as const) {
      expect(
        await errorCode(
          issuer().configure(owner.context, owner.organisationId, serviceId, {
            signingVariant: "PID-00",
            registrationVariant: variant,
          }),
        ),
      ).toBe("sandbox_variant_not_applicable");
    }
    const rp = await s.certificates.createService(owner.context, owner.organisationId, {
      role: "service_provider",
      ...SERVICE,
    });
    expect(
      await errorCode(
        issuer().configure(owner.context, owner.organisationId, rp.relyingPartyServiceId, {
          signingVariant: "PID-00",
          registrationVariant: "RC-00",
        }),
      ),
    ).toBe("sandbox_not_a_pid_provider");

    await harness.reset();
    s = await wireSandbox(harness, { walletProviderTrustListId: "wallet-providers" });
    owner = await s.signUp(person("Ana"), "PID Ejemplo");
    const again = await pidProvider();
    expect(
      await errorCode(
        issuer().configure(owner.context, owner.organisationId, again, {
          signingVariant: "PID-00",
          registrationVariant: "RC-00",
        }),
      ),
    ).toBe("sandbox_wallet_providers_missing");
  });
});

describe("issuing synthetic PIDs", () => {
  it("offers a PID with the typed values and the fixed issuing claims, and keeps none of them", async () => {
    const serviceId = await pidProvider();
    await issuer().configure(owner.context, owner.organisationId, serviceId, {
      signingVariant: "PID-00",
      registrationVariant: "RC-00",
    });
    const offer = await issuer().offer(owner.context, owner.organisationId, serviceId, VALUES);
    expect(offer.offerUri).toBeTruthy();
    expect(harness.issuer?.offers.at(-1)?.claimCount).toBe(7);
    const { rows } = await harness.handle.pool.query<{ dump: string }>(
      `SELECT concat_ws('|',
         (SELECT coalesce(json_agg(t)::text,'') FROM sandbox_issuances t),
         (SELECT coalesce(json_agg(t)::text,'') FROM issuance_transactions t),
         (SELECT coalesce(json_agg(t)::text,'') FROM audit_events t)) AS dump`,
    );
    for (const value of ["Zelda", "Quintanilla", "1991-02-03"])
      expect(rows[0]?.dump).not.toContain(value);
    expect(harness.logs.lines.join("\n")).not.toContain("Quintanilla");
  });

  it("revokes an issued PID once (PID-03), and never before it is issued", async () => {
    const serviceId = await pidProvider();
    await issuer().configure(owner.context, owner.organisationId, serviceId, {
      signingVariant: "PID-00",
      registrationVariant: "RC-00",
    });
    const offer = await issuer().offer(owner.context, owner.organisationId, serviceId, VALUES);
    expect(
      await errorCode(issuer().revoke(owner.context, owner.organisationId, offer.id)),
    ).toBe("sandbox_pid_not_issued");
    harness.issuer?.settleLastIssued();
    const status = await issuer().issuanceStatus(owner.context, owner.organisationId, offer.id);
    expect(status).toMatchObject({ status: "ISSUED", revocable: true });
    const revoked = await issuer().revoke(owner.context, owner.organisationId, offer.id);
    expect(revoked.revocable).toBe(false);
    expect(harness.issuer?.statusUpdates.at(-1)?.status).toBe("REVOKED");
    expect(
      await errorCode(issuer().revoke(owner.context, owner.organisationId, offer.id)),
    ).toBe("sandbox_pid_revoked");
  });

  it("refuses an offer before configuration, and keeps other organisations out", async () => {
    const serviceId = await pidProvider();
    expect(
      await errorCode(issuer().offer(owner.context, owner.organisationId, serviceId, VALUES)),
    ).toBe("sandbox_issuer_not_configured");
    await issuer().configure(owner.context, owner.organisationId, serviceId, {
      signingVariant: "PID-00",
      registrationVariant: "RC-00",
    });
    const offer = await issuer().offer(owner.context, owner.organisationId, serviceId, VALUES);
    const other = await s.signUp(person("Bruno", "1985-12-24"), "Otra");
    expect(
      await errorCode(issuer().issuanceStatus(other.context, owner.organisationId, offer.id)),
    ).toBe("not_found");
    expect(
      await errorCode(issuer().issuanceStatus(other.context, other.organisationId, offer.id)),
    ).toBe("not_found");
    expect(
      await errorCode(issuer().offer(other.context, other.organisationId, serviceId, VALUES)),
    ).toBe("not_found");
  });
});
