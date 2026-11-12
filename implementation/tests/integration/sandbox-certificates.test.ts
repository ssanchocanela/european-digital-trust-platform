import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeCompactJws,
  readStatusBit,
  verifyEs256,
  WRPAC_VARIANTS,
  WRPRC_VARIANT_INFO,
  WRPRC_VARIANTS,
  x5cCertificates,
} from "@edtp/sandbox-pki";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../support/harness.js";
import { errorCode, person, wireSandbox } from "../support/sandbox.js";

/** The sandbox certificate service end to end on a real database (S3). */
let harness: Harness;
let s: Awaited<ReturnType<typeof wireSandbox>>;
let owner: Awaited<ReturnType<Awaited<ReturnType<typeof wireSandbox>>["signUp"]>>;

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
    "/CN=ignored",
    "-out",
    join(dir, "r.pem"),
  ]);
  return readFileSync(join(dir, "r.pem"), "utf8");
}

const DNS = ["verifier.banco.test"];
const SERVICE = {
  tradeName: "Banco Ejemplo Onboarding",
  description: [{ lang: "en", value: "Account opening" }],
  supportUri: "https://banco.test/support",
  privacyPolicyUri: "https://banco.test/privacy",
  infoUri: "https://banco.test",
};

async function rpWithUse() {
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
      credentials: [
        {
          format: "dc+sd-jwt",
          types: ["urn:eudi:pid:1"],
          claims: [["given_name"], ["family_name"]],
        },
      ],
    },
  );
  return { serviceId: service.relyingPartyServiceId, intendedUseId: use.id as string };
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
  s = await wireSandbox(harness);
  owner = await s.signUp(person("Ana"), "Banco Ejemplo");
});

describe("services and intended uses", () => {
  it("creates the organisation's Relying Party with its SB identifier, and numbers services", async () => {
    const first = await s.certificates.createService(owner.context, owner.organisationId, {
      role: "service_provider",
      ...SERVICE,
    });
    const second = await s.certificates.createService(owner.context, owner.organisationId, {
      role: "pid_provider",
      ...SERVICE,
    });
    expect([first.serviceIdentifier, second.serviceIdentifier]).toEqual(["S001", "S002"]);
  });

  it("refuses an intended use on a PID Provider service (RPRC_05)", async () => {
    const service = await s.certificates.createService(owner.context, owner.organisationId, {
      role: "pid_provider",
      ...SERVICE,
    });
    expect(
      await errorCode(
        s.certificates.addIntendedUse(
          owner.context,
          owner.organisationId,
          service.relyingPartyServiceId,
          {
            purpose: [{ lang: "en", value: "x" }],
            credentials: [{ format: "dc+sd-jwt", types: ["t"], claims: [["a"]] }],
          },
        ),
      ),
    ).toBe("sandbox_intended_use_not_for_provider");
  });

  it("publishes the organisation in the signed register", async () => {
    await rpWithUse();
    const jws = decodeCompactJws(await s.register.list({}));
    const leaf = x5cCertificates(jws.header)[0] as X509Certificate;
    expect(verifyEs256(jws, leaf.publicKey)).toBe(true);
    expect(leaf.checkIssued(s.domain.x509("registrar"))).toBe(true);
    const data = jws.payload.data as {
      identifier: { identifier: string }[];
      verified: boolean;
      services: { intendedUses: unknown[] }[];
    }[];
    expect(data).toHaveLength(1);
    expect(data[0]?.identifier[0]?.identifier).toMatch(/^SB:ES-\d{6}$/);
    expect(data[0]?.verified).toBe(false);
    expect(data[0]?.services[0]?.intendedUses).toHaveLength(1);
    const check = decodeCompactJws(
      await s.register.checkIntendedUse({ intendedUseIdentifier: "S001-U01" }),
    );
    expect(check.payload.data).toEqual({ result: true });
  });
});

describe("access certificates", () => {
  it("issues a take-away certificate against a request, chained to the Access CA and self-tested", async () => {
    const { serviceId } = await rpWithUse();
    const cert = await s.certificates.issueAccessCertificate(
      owner.context,
      owner.organisationId,
      serviceId,
      {
        variant: "AC-00",
        csrPem: csr(),
        dnsNames: DNS,
      },
    );
    expect(cert.selfTest).toEqual({ fails: [], asDesigned: true });
    const x = new X509Certificate(cert.body as string);
    expect(x.checkIssued(s.domain.x509("access-ca"))).toBe(true);
    expect(x.subject).toMatch(/organizationIdentifier=SB:ES-\d{6}/);
    expect(x.subject).toContain("OU=S001");
  });

  for (const variant of WRPAC_VARIANTS) {
    it(`issues ${variant} failing exactly the check it is built to fail`, async () => {
      const { serviceId } = await rpWithUse();
      const cert = await s.certificates.issueAccessCertificate(
        owner.context,
        owner.organisationId,
        serviceId,
        {
          variant,
          csrPem: csr(),
          dnsNames: DNS,
        },
      );
      expect(cert.selfTest.asDesigned).toBe(true);
    });
  }

  it("refuses a bad request or a bad DNS name", async () => {
    const { serviceId } = await rpWithUse();
    expect(
      await errorCode(
        s.certificates.issueAccessCertificate(owner.context, owner.organisationId, serviceId, {
          variant: "AC-00",
          csrPem:
            "-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----",
          dnsNames: DNS,
        }),
      ),
    ).toBe("invalid_certification_request");
    expect(
      await errorCode(
        s.certificates.issueAccessCertificate(owner.context, owner.organisationId, serviceId, {
          variant: "AC-00",
          csrPem: csr(),
          dnsNames: ["*.banco.test"],
        }),
      ),
    ).toBe("invalid_dns_names");
  });

  it("revokes once, and the CRL lists the serial", async () => {
    const { serviceId } = await rpWithUse();
    const cert = await s.certificates.issueAccessCertificate(
      owner.context,
      owner.organisationId,
      serviceId,
      { variant: "AC-00", csrPem: csr(), dnsNames: DNS },
    );
    await s.certificates.revoke(owner.context, owner.organisationId, cert.id);
    expect(
      await errorCode(s.certificates.revoke(owner.context, owner.organisationId, cert.id)),
    ).toBe("sandbox_certificate_revoked");
    const crl = await s.publications.latest("crl:access-ca");
    const dir = mkdtempSync(join(tmpdir(), "sbx-crl-"));
    writeFileSync(join(dir, "c.crl"), Buffer.from(crl?.body ?? "", "base64"));
    writeFileSync(join(dir, "ca.pem"), s.domain.x509("access-ca").toString());
    const text = execFileSync(
      "openssl",
      ["crl", "-in", "c.crl", "-inform", "DER", "-CAfile", "ca.pem", "-noout", "-text"],
      { cwd: dir, encoding: "utf8" },
    );
    expect(text).toContain(
      `Serial Number: ${new X509Certificate(cert.body as string).serialNumber}`,
    );
  });
});

describe("registration certificates", () => {
  for (const variant of WRPRC_VARIANTS) {
    const info = WRPRC_VARIANT_INFO[variant];
    it(`issues ${variant} (${info.title}) failing exactly the check it is built to fail`, async () => {
      const role = info.appliesTo === "pid_provider" ? "pid_provider" : "service_provider";
      let serviceId: string;
      let intendedUseId: string | undefined;
      if (role === "service_provider") ({ serviceId, intendedUseId } = await rpWithUse());
      else
        serviceId = (
          await s.certificates.createService(owner.context, owner.organisationId, {
            role,
            ...SERVICE,
          })
        ).relyingPartyServiceId;
      // A correct access certificate first, so the binding can be checked.
      await s.certificates.issueAccessCertificate(
        owner.context,
        owner.organisationId,
        serviceId,
        { variant: "AC-00", csrPem: csr(), dnsNames: DNS },
      );
      const cert = await s.certificates.issueRegistrationCertificate(
        owner.context,
        owner.organisationId,
        serviceId,
        {
          variant,
          ...(intendedUseId ? { intendedUseId } : {}),
        },
      );
      expect(cert.selfTest.asDesigned, JSON.stringify(cert.selfTest)).toBe(true);
    });
  }

  it("refuses a variant that does not apply, and a Service Provider certificate without an intended use", async () => {
    const { serviceId } = await rpWithUse();
    expect(
      await errorCode(
        s.certificates.issueRegistrationCertificate(
          owner.context,
          owner.organisationId,
          serviceId,
          { variant: "RC-11" },
        ),
      ),
    ).toBe("sandbox_variant_not_applicable");
    expect(
      await errorCode(
        s.certificates.issueRegistrationCertificate(
          owner.context,
          owner.organisationId,
          serviceId,
          { variant: "RC-00" },
        ),
      ),
    ).toBe("intended_use_required");
  });

  it("sets its bit in the status list when revoked", async () => {
    const { serviceId, intendedUseId } = await rpWithUse();
    const cert = await s.certificates.issueRegistrationCertificate(
      owner.context,
      owner.organisationId,
      serviceId,
      { variant: "RC-00", intendedUseId },
    );
    const index = (
      decodeCompactJws(cert.body as string).payload.status as { status_list: { idx: number } }
    ).status_list.idx;
    await s.certificates.revoke(owner.context, owner.organisationId, cert.id);
    const list = decodeCompactJws(
      (await s.publications.latest("status:registrar-signing"))?.body ?? "",
    );
    expect(readStatusBit((list.payload.status_list as { lst: string }).lst, index)).toBe(1);
  });
});

describe("publications", () => {
  it("publishes every channel once, and nothing again until content changes", async () => {
    expect(await s.publications.publishAll()).toBe(7);
    expect(await s.publications.publishAll()).toBe(0);
    const lote = decodeCompactJws((await s.publications.latest("lote:WRPAC"))?.body ?? "");
    expect(JSON.stringify(lote.payload)).toContain(
      s.domain.certificate("access-ca").toString("base64"),
    );
    expect(JSON.stringify(lote.payload)).not.toContain(
      s.domain.certificate("access-ca-untrusted").toString("base64"),
    );
  });

  it("re-issues a list before it lapses, with the next sequence number", async () => {
    await s.publications.publishAll();
    harness.clock.advance(6 * 86_400_000);
    await s.publications.publishIfNeeded("lote:PID");
    const latest = await s.publications.latest("lote:PID");
    expect(latest?.sequence).toBe(2);
  });
});

describe("isolation", () => {
  it("answers another organisation's service and certificates as not found", async () => {
    const { serviceId } = await rpWithUse();
    const other = await s.signUp(person("Bruno", "1985-12-24"), "Otra");
    expect(
      await errorCode(s.certificates.service(other.context, owner.organisationId, serviceId)),
    ).toBe("not_found");
    expect(
      await errorCode(s.certificates.certificates(other.context, owner.organisationId)),
    ).toBe("not_found");
    expect(
      await errorCode(s.certificates.service(other.context, other.organisationId, serviceId)),
    ).toBe("not_found");
  });
});
