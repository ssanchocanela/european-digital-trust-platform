import { X509Certificate } from "node:crypto";
import { decodeCompactJws, ENTITLEMENT_NON_Q_EAA_PROVIDER } from "@edtp/sandbox-pki";
import { newCorrelationId } from "@edtp/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../support/harness.js";
import { errorCode, PUBLIC_BASE, person, wireSandbox } from "../support/sandbox.js";

/**
 * EAA Providers in the sandbox (ADR 0023), on a real database with fake engine ports: credential types
 * and their vct, the hosted EAA issuer, the registration certificate's entitlement and provided types,
 * the register, and a Relying Party requesting an EAA.
 */
let harness: Harness;
let s: Awaited<ReturnType<typeof wireSandbox>>;
let owner: Awaited<ReturnType<Awaited<ReturnType<typeof wireSandbox>>["signUp"]>>;

const SERVICE = {
  tradeName: "Club Ejemplo",
  description: [{ lang: "en", value: "Membership cards" }],
  supportUri: "https://club.test/support",
  privacyPolicyUri: "https://club.test/privacy",
  infoUri: "https://club.test",
};

const MEMBERSHIP = {
  slug: "membership-card",
  definition: {
    display: [
      { lang: "en", value: "Membership card" },
      { lang: "es", value: "Carné de socio" },
    ],
    claims: [
      {
        name: "member_number",
        display: [{ lang: "en", value: "Member number" }],
        valueType: "string" as const,
        mandatory: true,
      },
      {
        name: "member_since",
        display: [{ lang: "en", value: "Member since" }],
        valueType: "date" as const,
        mandatory: true,
      },
      {
        name: "premium",
        display: [{ lang: "en", value: "Premium" }],
        valueType: "boolean" as const,
        mandatory: false,
      },
    ],
    validitySeconds: 31_536_000,
  },
};

async function eaaProvider() {
  const service = await s.certificates.createService(owner.context, owner.organisationId, {
    role: "eaa_provider",
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
  s = await wireSandbox(harness);
  owner = await s.signUp(person("Ana"), "Club Ejemplo");
});

describe("credential types", () => {
  it("assigns the vct under the sandbox's address, versions a type without changing its vct, and serves its Type Metadata", async () => {
    const serviceId = await eaaProvider();
    const v1 = await s.credentialTypes.create(
      owner.context,
      owner.organisationId,
      serviceId,
      MEMBERSHIP,
    );
    expect(v1.version).toBe(1);
    expect(v1.vct.startsWith(`${PUBLIC_BASE}/vct/`)).toBe(true);
    expect(v1.vct.endsWith("/membership-card")).toBe(true);
    const v2 = await s.credentialTypes.create(owner.context, owner.organisationId, serviceId, {
      ...MEMBERSHIP,
      definition: { ...MEMBERSHIP.definition, validitySeconds: 3_600 },
    });
    expect(v2.version).toBe(2);
    expect(v2.vct).toBe(v1.vct);

    const listed = await s.credentialTypes.list(owner.context, owner.organisationId, serviceId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.versions.map((v) => v.version)).toEqual([2, 1]);

    const [segment, slug] = v1.vct.slice(`${PUBLIC_BASE}/vct/`.length).split("/") as [
      string,
      string,
    ];
    const metadata = await s.credentialTypes.metadata(segment, slug);
    expect(metadata).toMatchObject({ vct: v1.vct, name: "Membership card" });
    expect(metadata.claims).toEqual([
      expect.objectContaining({ path: ["member_number"], sd: "always" }),
      expect.objectContaining({ path: ["member_since"] }),
      expect.objectContaining({ path: ["premium"] }),
    ]);
    expect(await errorCode(s.credentialTypes.metadata(segment, "no-such-type"))).toBe(
      "not_found",
    );
  });

  it("refuses a reserved claim name, a bad slug, and a service that is not an EAA Provider", async () => {
    const serviceId = await eaaProvider();
    const reserved = {
      ...MEMBERSHIP,
      definition: {
        ...MEMBERSHIP.definition,
        claims: [{ ...MEMBERSHIP.definition.claims[0], name: "vct" }],
      },
    };
    expect(
      await errorCode(
        s.credentialTypes.create(
          owner.context,
          owner.organisationId,
          serviceId,
          reserved as never,
        ),
      ),
    ).toBe("claim_name_reserved");
    expect(
      await errorCode(
        s.credentialTypes.create(owner.context, owner.organisationId, serviceId, {
          ...MEMBERSHIP,
          slug: "Membership Card",
        }),
      ),
    ).toBe("credential_type_slug_invalid");
    const rp = await s.certificates.createService(owner.context, owner.organisationId, {
      role: "service_provider",
      ...SERVICE,
    });
    expect(
      await errorCode(
        s.credentialTypes.create(
          owner.context,
          owner.organisationId,
          rp.relyingPartyServiceId,
          MEMBERSHIP,
        ),
      ),
    ).toBe("sandbox_not_an_eaa_provider");
  });
});

describe("the hosted EAA issuer", () => {
  it("signs under the sandbox EAA CA, provisions each type, and offers an EAA with the typed values", async () => {
    const serviceId = await eaaProvider();
    const type = await s.credentialTypes.create(
      owner.context,
      owner.organisationId,
      serviceId,
      MEMBERSHIP,
    );
    expect(type.issuable).toBe(false); // no issuer yet
    const view = await issuer().configure(owner.context, owner.organisationId, serviceId, {
      signingVariant: "EAA-00",
      registrationVariant: "RC-00",
    });
    if (!view.configured) throw new Error("not configured");
    expect(view.role).toBe("eaa_provider");
    const x = new X509Certificate(view.signingCertificate.body as string);
    expect(x.checkIssued(s.domain.x509("eaa-ca"))).toBe(true);
    expect(view.signingCertificate.kind).toBe("EAA_SIGNING");
    expect(harness.issuer?.provisioned.at(-1)?.vct).toBe(type.vct);

    // The registration certificate: the EAA Provider entitlement, and the type as provided.
    const payload = decodeCompactJws(view.registrationCertificate.body as string).payload as {
      entitlements: string[];
      provides_attestations: { meta: { vct_values: string[] } }[];
    };
    expect(payload.entitlements).toEqual([ENTITLEMENT_NON_Q_EAA_PROVIDER]);
    expect(payload.provides_attestations.flatMap((p) => p.meta.vct_values)).toEqual([type.vct]);
    expect(view.registrationCertificate.selfTest).toMatchObject({ asDesigned: true });

    // A type created after configuration is issuable at once.
    const later = await s.credentialTypes.create(
      owner.context,
      owner.organisationId,
      serviceId,
      {
        ...MEMBERSHIP,
        slug: "season-ticket",
      },
    );
    expect(later.issuable).toBe(true);

    const offers = harness.issuer?.offers.length ?? 0;
    const offer = await issuer().offerEaa(
      owner.context,
      owner.organisationId,
      serviceId,
      type.id,
      {
        member_number: "A-0001",
        member_since: "2020-01-31",
        premium: "true",
      },
    );
    expect(offer.offerUri).toMatch(/^openid-credential-offer:/);
    expect(harness.issuer?.offers.length).toBe(offers + 1);
  });

  it("refuses a PID variant on an EAA issuer, values that do not fit the type, and a second EAA issuer", async () => {
    const serviceId = await eaaProvider();
    const type = await s.credentialTypes.create(
      owner.context,
      owner.organisationId,
      serviceId,
      MEMBERSHIP,
    );
    expect(
      await errorCode(
        issuer().configure(owner.context, owner.organisationId, serviceId, {
          signingVariant: "PID-00",
          registrationVariant: "RC-00",
        }),
      ),
    ).toBe("sandbox_variant_not_applicable");
    await issuer().configure(owner.context, owner.organisationId, serviceId, {
      signingVariant: "EAA-01",
      registrationVariant: "RC-00",
    });
    expect(
      await errorCode(
        issuer().offerEaa(owner.context, owner.organisationId, serviceId, type.id, {
          member_number: "A-0001",
          member_since: "31/01/2020",
        }),
      ),
    ).toBe("claim_not_a_date");
    expect(
      await errorCode(
        issuer().offerEaa(owner.context, owner.organisationId, serviceId, type.id, {
          member_number: "A-0001",
          member_since: "2020-01-31",
          family_name: "X",
        }),
      ),
    ).toBe("claim_unknown");
    const second = await eaaProvider();
    expect(
      await errorCode(
        issuer().configure(owner.context, owner.organisationId, second, {
          signingVariant: "EAA-00",
          registrationVariant: "RC-00",
        }),
      ),
    ).toBe("sandbox_quota_exceeded");
  });

  it("signs EAA-01 under the untrusted EAA CA, which is on no list", async () => {
    const serviceId = await eaaProvider();
    const view = await issuer().configure(owner.context, owner.organisationId, serviceId, {
      signingVariant: "EAA-01",
      registrationVariant: "RC-00",
    });
    if (!view.configured) throw new Error("not configured");
    const x = new X509Certificate(view.signingCertificate.body as string);
    expect(x.checkIssued(s.domain.x509("eaa-ca-untrusted"))).toBe(true);
    expect(view.signingCertificate.requirement).toContain("AS-AP-10-010");
  });
});

describe("the register and Relying Parties", () => {
  it("lists the type as provided, and lets a Relying Party request it against the EAA list", async () => {
    const serviceId = await eaaProvider();
    const type = await s.credentialTypes.create(
      owner.context,
      owner.organisationId,
      serviceId,
      MEMBERSHIP,
    );
    const register = decodeCompactJws(await s.register.list({})).payload as {
      data: {
        services: {
          entitlements: string[];
          providesAttestations: { type: string }[];
        }[];
      }[];
    };
    const services = register.data.flatMap((e) => e.services);
    expect(services).toContainEqual(
      expect.objectContaining({
        entitlements: [ENTITLEMENT_NON_Q_EAA_PROVIDER],
        providesAttestations: [{ format: "dc+sd-jwt", type: type.vct }],
      }),
    );

    const rp = await s.certificates.createService(owner.context, owner.organisationId, {
      role: "service_provider",
      ...SERVICE,
      tradeName: "Tienda Ejemplo",
    });
    const use = await s.certificates.addIntendedUse(
      owner.context,
      owner.organisationId,
      rp.relyingPartyServiceId,
      {
        purpose: [{ lang: "en", value: "Check membership" }],
        credentials: [{ format: "dc+sd-jwt", types: [type.vct], claims: [["member_number"]] }],
      },
    );
    await s.verifier.configure(owner.context, owner.organisationId, rp.relyingPartyServiceId, {
      accessVariant: "AC-00",
      uses: [{ intendedUseId: use.id as string, registrationVariant: "RC-00" }],
    });
    const ref = s.createdEngineTenants.at(-1) as string;
    expect(harness.verifier.trustLists).toContainEqual({
      engineTenantRef: ref,
      listId: "sbx-eaa-providers",
      issuers: 1,
    });
    await s.verifier.startRun(owner.context, owner.organisationId, rp.relyingPartyServiceId, {
      intendedUseId: use.id as string,
      interaction: "SAME_DEVICE",
      correlationId: newCorrelationId(),
    });
    const plan = harness.verifier.createdRequests.at(-1)?.plan as unknown as Record<
      string,
      unknown
    >;
    // The policy names the EAA list as its anchor source; the adapter maps it to the engine's list.
    expect(JSON.stringify(plan)).toContain(type.vct);
    expect(JSON.stringify(plan)).toContain(`${PUBLIC_BASE}/lote/EAAProviders.jwt`);
    expect(JSON.stringify(plan)).toContain("EAA_PROVIDER");
  });

  it("refuses an intended use that requests a claim the type does not have", async () => {
    const serviceId = await eaaProvider();
    const type = await s.credentialTypes.create(
      owner.context,
      owner.organisationId,
      serviceId,
      MEMBERSHIP,
    );
    const rp = await s.certificates.createService(owner.context, owner.organisationId, {
      role: "service_provider",
      ...SERVICE,
      tradeName: "Tienda Ejemplo",
    });
    const use = await s.certificates.addIntendedUse(
      owner.context,
      owner.organisationId,
      rp.relyingPartyServiceId,
      {
        purpose: [{ lang: "en", value: "Check membership" }],
        credentials: [{ format: "dc+sd-jwt", types: [type.vct], claims: [["given_name"]] }],
      },
    );
    expect(
      await errorCode(
        s.verifier.configure(owner.context, owner.organisationId, rp.relyingPartyServiceId, {
          accessVariant: "AC-00",
          uses: [{ intendedUseId: use.id as string, registrationVariant: "RC-00" }],
        }),
      ),
    ).toBe("sandbox_claim_not_in_type");
  });
});
