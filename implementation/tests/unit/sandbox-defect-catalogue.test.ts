import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTrustDomain,
  decodeCompactJws,
  encodeStatusBits,
  FileKeyStore,
  failedChecks,
  findOverAsked,
  type IssuedMember,
  issueWrpac,
  issueWrprc,
  nameOf,
  readStatusBit,
  type SandboxKeyStore,
  serialToHex,
  signStatusListToken,
  TRUST_DOMAIN,
  validateWrpac,
  validateWrprc,
  WRPAC_VARIANT_INFO,
  WRPAC_VARIANTS,
  WRPRC_VARIANT_INFO,
  WRPRC_VARIANTS,
  type WrpacVariant,
  type WrprcInput,
  type WrprcVariant,
  wrprcPayload,
} from "@edtp/sandbox-pki";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The defect catalogue as a self-test (specification §5): every variant the sandbox issues fails
 * exactly the check its row names, and the correct certificate fails none. If a variant ever starts
 * failing a second check, a wallet would stop at the wrong one and the defect under test would never
 * be reached — so this is the property that matters.
 */
const now = new Date("2026-11-12T10:00:00Z");
let store: SandboxKeyStore;
let domain: Map<string, IssuedMember>;
const cert = (name: string) =>
  new X509Certificate((domain.get(name) as IssuedMember).certificate);

const org = {
  legalName: "Banco Ejemplo S.A.",
  tradeName: "Banco Ejemplo",
  country: "ES",
  localIdentifier: "SB:ES-000042",
  isPublicSectorBody: false,
};
const urls = {
  cps: "https://sandbox.test/cps",
  crl: "https://sandbox.test/crl/access-ca.crl",
  caIssuers: "https://sandbox.test/ca/access-ca.cer",
  register: "https://sandbox.test/wrp",
};
const STATUS_URI = "https://sandbox.test/status/registrar";
const UNREACHABLE = "https://sandbox.test/status/unavailable";
const DNS = "verifier.sandbox.test";

beforeAll(async () => {
  store = new FileKeyStore(mkdtempSync(join(tmpdir(), "sbx-cat-")), Buffer.alloc(32, 4));
  const issued = await createTrustDomain(store, new Date(now.getTime() - 86_400_000));
  domain = new Map(issued.map((i) => [i.member.name, i]));
});

async function wrpac(variant: WrpacVariant) {
  const info = WRPAC_VARIANT_INFO[variant];
  const issuer = TRUST_DOMAIN.find((m) => m.name === info.issuer);
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return issueWrpac({
    variant,
    subject: {
      ...org,
      serviceIdentifier: "service-1",
      supportUri: "https://banco.test/support",
      dnsNames: [DNS],
    },
    subjectPublicKey: publicKey,
    issuer: { name: nameOf(issuer?.commonName ?? ""), signer: await store.signer(info.issuer) },
    urls,
    now,
  });
}

async function wrprc(variant: WrprcVariant, kind: WrprcInput["kind"]) {
  const info = WRPRC_VARIANT_INFO[variant];
  const signingKey = `${info.signer}-signing`;
  const input: WrprcInput = {
    variant,
    kind,
    organisation: org,
    service: {
      identifier: "service-1",
      description: [{ lang: "en", value: "Account opening" }],
    },
    intendedUse: {
      identifier: "use-1",
      purpose: [{ lang: "en", value: "Identify the customer" }],
      credentials: [
        {
          format: "dc+sd-jwt",
          types: ["urn:eudi:pid:1"],
          claims: [["given_name"], ["family_name"]],
        },
      ],
    },
    providesAttestations: [{ format: "dc+sd-jwt", type: "urn:eudi:pid:1" }],
    urls: {
      registry: "https://sandbox.test/wrp/SB:ES-000042",
      info: "https://banco.test",
      support: "https://banco.test/support",
      privacyPolicy: "https://banco.test/privacy",
      certificatePolicy: "https://sandbox.test/cps",
      unreachableStatus: UNREACHABLE,
    },
    status: { index: 5, uri: STATUS_URI },
    now,
    signer: await store.signer(signingKey),
    chain: [
      (domain.get(signingKey) as IssuedMember).certificate,
      (domain.get(info.signer) as IssuedMember).certificate,
    ],
  };
  return issueWrprc(input);
}

describe("WRPAC variants", () => {
  for (const variant of WRPAC_VARIANTS) {
    it(`${variant} (${WRPAC_VARIANT_INFO[variant].title}) fails exactly ${WRPAC_VARIANT_INFO[variant].fails ?? "nothing"}`, async () => {
      const { der, serial } = await wrpac(variant);
      const revoked = variant === "AC-04" ? new Set([serialToHex(serial)]) : new Set<string>();
      const results = validateWrpac(der, {
        trustedCa: cert("access-ca"),
        revokedSerials: revoked,
        expectedDnsNames: [DNS],
        at: now,
      });
      const expected = WRPAC_VARIANT_INFO[variant].fails;
      expect(failedChecks(results)).toEqual(expected ? [expected] : []);
    });
  }

  it("carries TEST in the organisation name, the SB identifier and the sandbox policy", async () => {
    const x = new X509Certificate((await wrpac("AC-00")).der);
    expect(x.subject).toContain("O=TEST Banco Ejemplo S.A.");
    expect(x.subject).toContain("organizationIdentifier=SB:ES-000042");
    expect(x.checkIssued(cert("access-ca"))).toBe(true);
  });
});

describe("WRPRC variants", () => {
  const statusOf = (revoked: boolean) => (uri: string) =>
    uri === UNREACHABLE
      ? ("unreachable" as const)
      : revoked
        ? ("revoked" as const)
        : ("valid" as const);

  for (const variant of WRPRC_VARIANTS) {
    const info = WRPRC_VARIANT_INFO[variant];
    if (variant === "RC-01") continue; // the absence of a certificate: covered below
    const kind = info.appliesTo === "pid_provider" ? "pid_provider" : "service_provider";
    it(`${variant} (${info.title}) fails exactly ${info.fails ?? "nothing"}`, async () => {
      const access = new X509Certificate((await wrpac("AC-00")).der);
      const compact = await wrprc(variant, kind);
      const results = validateWrprc(compact, {
        trustedRegistrar: cert("registrar"),
        accessCertificate: access,
        at: now,
        kind,
        statusOf: statusOf(variant === "RC-07"),
        ...(kind === "service_provider"
          ? {
              requested: [
                { format: "dc+sd-jwt", type: "urn:eudi:pid:1", path: ["given_name"] },
              ],
            }
          : { issuedType: "urn:eudi:pid:1" }),
      });
      expect(failedChecks(results)).toEqual(info.fails ? [info.fails] : []);
    });
  }

  it("RC-01 is not a certificate at all", async () => {
    await expect(wrprc("RC-01", "service_provider")).rejects.toThrow(/nothing is issued/);
  });

  it("has the ETSI header and the claims Wallet Core reads", async () => {
    const jws = decodeCompactJws(await wrprc("RC-00", "service_provider"));
    expect(jws.header.typ).toBe("rc-wrp+jwt");
    expect(jws.header.alg).toBe("ES256");
    expect(jws.header.sigT).toBeUndefined();
    expect(jws.header.iat).toBe(jws.payload.iat);
    expect((jws.header.x5c as string[]).length).toBe(2);
    expect(jws.payload.status).toEqual({ status_list: { idx: 5, uri: STATUS_URI } });
    expect(jws.payload.entitlements).toEqual([
      "https://uri.etsi.org/19475/Entitlement/Service_Provider",
    ]);
    expect(jws.payload.policy_id).toEqual(["0.4.0.19475.3.1"]);
    expect(JSON.stringify(jws.payload.supervisory_authority)).toContain("sandbox.invalid");
  });

  it("puts no intended use in a provider certificate (RPRC_05)", async () => {
    const jws = decodeCompactJws(await wrprc("RC-00", "pid_provider"));
    expect(jws.payload.intended_use_id).toBeUndefined();
    expect(jws.payload.credentials).toBeUndefined();
    expect(jws.payload.entitlements).toEqual([
      "https://uri.etsi.org/19475/Entitlement/PID_Provider",
    ]);
  });
});

describe("the compliance guard", () => {
  const registered = [
    {
      format: "dc+sd-jwt" as const,
      types: ["urn:eudi:pid:1"],
      claims: [["address"], ["nationalities", null]],
    },
  ];
  it("lets a registered path cover its subtree, and null any array index", () => {
    expect(
      findOverAsked(registered, [
        { format: "dc+sd-jwt", type: "urn:eudi:pid:1", path: ["address", "locality"] },
        { format: "dc+sd-jwt", type: "urn:eudi:pid:1", path: ["nationalities", 0] },
      ]),
    ).toEqual([]);
  });
  it("flags a request outside the registration, another type, or another format", () => {
    expect(
      findOverAsked(registered, [
        { format: "dc+sd-jwt", type: "urn:eudi:pid:1", path: ["birthdate"] },
        { format: "dc+sd-jwt", type: "urn:other", path: ["address"] },
        { format: "mso_mdoc", type: "urn:eudi:pid:1", path: ["address"] },
      ]),
    ).toHaveLength(3);
  });
  it("treats a registered credential with no claims as covering its whole type", () => {
    expect(
      findOverAsked(
        [{ format: "dc+sd-jwt", types: ["t"], claims: [] }],
        [{ format: "dc+sd-jwt", type: "t", path: ["x"] }],
      ),
    ).toEqual([]);
  });
});

describe("the status list", () => {
  it("sets the right bit, least significant first, and round-trips", () => {
    const lst = encodeStatusBits(new Set([0, 9, 15]), 64);
    expect([0, 1, 8, 9, 15, 16].map((i) => readStatusBit(lst, i))).toEqual([1, 0, 0, 1, 1, 0]);
  });

  it("is a statuslist+jwt signed by the registrar, its leaf in x5c", async () => {
    const token = signStatusListToken({
      uri: STATUS_URI,
      revoked: new Set([5]),
      size: 1024,
      issuedAt: now,
      validitySeconds: 86_400,
      ttlSeconds: 3_600,
      signer: await store.signer("registrar-signing"),
      chain: [(domain.get("registrar-signing") as IssuedMember).certificate],
    });
    const jws = decodeCompactJws(token);
    expect(jws.header.typ).toBe("statuslist+jwt");
    expect(jws.payload.sub).toBe(STATUS_URI);
    const list = jws.payload.status_list as { bits: number; lst: string };
    expect(list.bits).toBe(1);
    expect(readStatusBit(list.lst, 5)).toBe(1);
  });

  it("refuses an x5c leaf that is not the signing key", async () => {
    await expect(async () =>
      signStatusListToken({
        uri: STATUS_URI,
        revoked: new Set(),
        size: 8,
        issuedAt: now,
        validitySeconds: 60,
        ttlSeconds: 60,
        signer: await store.signer("registrar-signing"),
        chain: [(domain.get("registrar") as IssuedMember).certificate],
      }),
    ).rejects.toThrow(/not the signing key/);
  });
});

it("RC-08's payload registers a claim no request asks for", async () => {
  const payload = wrprcPayload({
    variant: "RC-08",
    kind: "service_provider",
    organisation: org,
    service: { identifier: "s", description: [] },
    intendedUse: {
      identifier: "u",
      purpose: [],
      credentials: [{ format: "dc+sd-jwt", types: ["t"], claims: [["a"]] }],
    },
    urls: {
      registry: "r",
      info: "i",
      support: "s",
      privacyPolicy: "p",
      certificatePolicy: "c",
      unreachableStatus: "x",
    },
    status: { index: 0, uri: "u" },
    now,
    signer: await store.signer("registrar-signing"),
    chain: [],
  });
  expect(JSON.stringify(payload.credentials)).toContain("_edtp_rc08_not_requested");
});

describe("PID signing certificates (S5)", () => {
  async function pidSigning(variant: "PID-00" | "PID-01" | "PID-02") {
    const { issuePidSigningCertificate, PID_VARIANT_INFO } = await import("@edtp/sandbox-pki");
    const info = PID_VARIANT_INFO[variant];
    const issuer = TRUST_DOMAIN.find((m) => m.name === info.issuer);
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const { der } = issuePidSigningCertificate({
      variant,
      subject: org,
      subjectPublicKey: publicKey,
      issuer: {
        name: nameOf(issuer?.commonName ?? ""),
        signer: await store.signer(info.issuer),
      },
      now,
    });
    return new X509Certificate(der);
  }

  it("PID-00 chains to the sandbox PID CA, the anchor the PID list carries", async () => {
    const x = await pidSigning("PID-00");
    expect(x.checkIssued(cert("pid-ca"))).toBe(true);
    expect(x.subject).toContain("organizationIdentifier=SB:ES-000042");
    expect(x.ca).toBe(false);
    expect(Date.parse(x.validTo)).toBeGreaterThan(now.getTime());
  });

  it("PID-01 chains to the untrusted PID CA only", async () => {
    const x = await pidSigning("PID-01");
    expect(x.checkIssued(cert("pid-ca"))).toBe(false);
    expect(x.checkIssued(cert("pid-ca-untrusted"))).toBe(true);
  });

  it("PID-02 has expired, under the trusted CA", async () => {
    const x = await pidSigning("PID-02");
    expect(x.checkIssued(cert("pid-ca"))).toBe(true);
    expect(Date.parse(x.validTo)).toBeLessThan(now.getTime());
  });
});
