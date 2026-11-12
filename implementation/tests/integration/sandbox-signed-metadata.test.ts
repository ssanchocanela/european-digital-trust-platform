import { generateKeyPairSync, sign, type X509Certificate } from "node:crypto";
import {
  decodeCompactJws,
  issueCertificate,
  OID,
  randomSerial,
  verifyEs256,
  x5cCertificates,
} from "@edtp/sandbox-pki";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../support/harness.js";
import { errorCode, person, VERIFIER_DNS, wireSandbox } from "../support/sandbox.js";

/**
 * Signed issuer metadata for sandbox issuers (S5b, ADR 0016), as the pinned wallet's OpenID4VCI
 * library 0.13.1 checks it: `typ` `openidvci-issuer-metadata+jwt`, `x5c`, `sub` equal to the
 * Credential Issuer, `iat`, and the metadata as the claims — with `issuer_info` at the top level of the
 * signed payload (ETSI TS 119 472-3 `ISS-MDATA-REG_CERT-4.2.3-02`).
 */
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

async function configuredIssuer(
  input: {
    accessVariant?: "AC-00" | "AC-01";
    registrationVariant?: "RC-00" | "RC-11" | "RC-12";
  } = {},
) {
  const service = await s.certificates.createService(owner.context, owner.organisationId, {
    role: "pid_provider",
    ...SERVICE,
  });
  await s.issuer?.configure(
    owner.context,
    owner.organisationId,
    service.relyingPartyServiceId,
    {
      signingVariant: "PID-00",
      registrationVariant: input.registrationVariant ?? "RC-00",
      accessVariant: input.accessVariant ?? "AC-00",
    },
  );
  return s.createdEngineTenants.at(-1) as string;
}

const metadata = () => {
  if (!s.metadata) throw new Error("no metadata service");
  return s.metadata;
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

describe("signed issuer metadata", () => {
  it("signs the engine's metadata as the pinned wallet checks it, with the access certificate in x5c", async () => {
    const ref = await configuredIssuer();
    const { json, jwt } = await metadata().metadata(ref);
    expect(jwt).toBeDefined();
    const jws = decodeCompactJws(jwt as string);
    expect(jws.header).toMatchObject({ alg: "ES256", typ: "openidvci-issuer-metadata+jwt" });
    const [leaf, ca] = x5cCertificates(jws.header) as [X509Certificate, X509Certificate];
    expect(verifyEs256(jws, leaf.publicKey)).toBe(true);
    expect(leaf.checkIssued(s.domain.x509("access-ca"))).toBe(true);
    expect(ca.fingerprint256).toBe(s.domain.x509("access-ca").fingerprint256);
    expect(leaf.subjectAltName).toContain(`DNS:${VERIFIER_DNS}`);
    expect(leaf.subject).toMatch(/organizationIdentifier=SB:ES-\d{6}/);
    // The metadata is the claim set: every field as served, plus sub and iat.
    expect(jws.payload.sub).toBe(json.credential_issuer);
    expect(typeof jws.payload.iat).toBe("number");
    for (const [key, value] of Object.entries(json)) expect(jws.payload[key]).toEqual(value);
    expect(Array.isArray(jws.payload.issuer_info)).toBe(true);
  });

  it("signs with an access certificate of the chosen variant: AC-01 chains to the untrusted Access CA", async () => {
    const ref = await configuredIssuer({ accessVariant: "AC-01" });
    const { jwt } = await metadata().metadata(ref);
    const [leaf] = x5cCertificates(decodeCompactJws(jwt as string).header) as [X509Certificate];
    expect(leaf.checkIssued(s.domain.x509("access-ca"))).toBe(false);
    expect(leaf.checkIssued(s.domain.x509("access-ca-untrusted"))).toBe(true);
  });

  it("now offers the issuance-side defects on the hosted issuer (RC-11, RC-12)", async () => {
    // One hosted issuer per organisation (the S6 quota): RC-12 reconfigures the issuer RC-11 made.
    const ref = await configuredIssuer({ registrationVariant: "RC-11" });
    expect((await metadata().metadata(ref)).jwt).toBeDefined();
    const serviceId = (await s.certificates.services(owner.context, owner.organisationId)).at(-1)
      ?.relyingPartyServiceId as string;
    await s.issuer?.configure(owner.context, owner.organisationId, serviceId, {
      signingVariant: "PID-00",
      registrationVariant: "RC-12",
    });
    expect((await metadata().metadata(ref)).jwt).toBeDefined();
  });

  it("uses a fresh key for every configuration, never the previous one", async () => {
    const service = await s.certificates.createService(owner.context, owner.organisationId, {
      role: "pid_provider",
      ...SERVICE,
    });
    const id = service.relyingPartyServiceId;
    await s.issuer?.configure(owner.context, owner.organisationId, id, {
      signingVariant: "PID-00",
      registrationVariant: "RC-00",
    });
    const ref = s.createdEngineTenants.at(-1) as string;
    const first = x5cCertificates(
      decodeCompactJws((await metadata().metadata(ref)).jwt as string).header,
    )[0];
    await s.issuer?.configure(owner.context, owner.organisationId, id, {
      signingVariant: "PID-00",
      registrationVariant: "RC-00",
    });
    const second = x5cCertificates(
      decodeCompactJws((await metadata().metadata(ref)).jwt as string).header,
    )[0];
    expect(second?.publicKey.export({ format: "jwk" }).x).not.toBe(
      first?.publicKey.export({ format: "jwk" }).x,
    );
  });

  it("answers anything but a sandbox issuer's engine tenant as not found", async () => {
    expect(await errorCode(metadata().metadata("pid-1"))).toBe("not_found");
    expect(await errorCode(metadata().metadata("sbx-iss-000000000000"))).toBe("not_found");
    expect(await errorCode(metadata().metadata("sbx-rp-abcdefabcdef"))).toBe("not_found");
  });
});
