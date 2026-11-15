import { generateKeyPairSync, sign } from "node:crypto";
import {
  basicConstraints,
  decodeCompactJws,
  issueCertificate,
  keyUsage,
  OID,
  randomSerial,
  toPem,
} from "@edtp/sandbox-pki";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../support/harness.js";
import { errorCode, identity, wireSandbox } from "../support/sandbox.js";

/**
 * Wallet Providers bring their wallets (ADR 0020), on a real database with the fake engine: upload,
 * the operator's approval, the published list, the hosted issuers' lists rewritten, withdrawal and
 * suspension taking anchors off — and what is refused on the way.
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

function ca(name: string): string {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const dn = [{ type: OID.commonName, value: name }];
  const now = harness.clock.now();
  return toPem(
    issueCertificate(
      {
        serial: randomSerial(),
        issuer: dn,
        subject: dn,
        notBefore: new Date(now.getTime() - 86_400_000),
        notAfter: new Date(now.getTime() + 365 * 86_400_000),
        subjectPublicKey: publicKey,
        extensions: [basicConstraints(true), keyUsage(["keyCertSign", "cRLSign"])],
      },
      { publicKey, sign: (d) => sign("sha256", d, { key: privateKey, dsaEncoding: "der" }) },
    ),
    "CERTIFICATE",
  );
}

const euDevWalletProvider = () => ({
  name: "EUDI dev Wallet Provider",
  certificate: Buffer.from(
    ca("EUDI dev Wallet Provider").replace(/-----[^-]+-----|\s/g, ""),
    "base64",
  ),
});

async function walletProvider(name = "Wallet Co") {
  const owner = await s.signUp(undefined, name);
  const service = await s.certificates.createService(owner.context, owner.organisationId, {
    role: "wallet_provider",
    tradeName: `${name} Wallet`,
    ...SERVICE,
  });
  return { ...owner, serviceId: service.relyingPartyServiceId };
}

async function operator() {
  const done = await s.sandbox.createProfile(identity(OPERATOR), { displayName: "Operator" });
  return s.sandbox.authenticate(done.sessionToken);
}

async function listedSubjects(): Promise<string[]> {
  const latest = await s.publications.latest("lote:WalletProviders");
  if (!latest) return [];
  const lote = (decodeCompactJws(latest.body).payload as { LoTE: Record<string, unknown> })
    .LoTE;
  const entities = lote.TrustedEntitiesList as {
    TrustedEntityServices: { ServiceInformation: { ServiceName: { value: string }[] } }[];
  }[];
  return entities.flatMap((e) =>
    e.TrustedEntityServices.map((x) => x.ServiceInformation.ServiceName[0]?.value ?? ""),
  );
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
  s = await wireSandbox(harness, {
    walletProviderAnchors: [euDevWalletProvider()],
    walletProviderTrustListId: "wallet-providers",
    operatorEmails: [OPERATOR],
  });
});

describe("a Wallet Provider's anchor (ADR 0020 §2–§3)", () => {
  it("is pending after upload, on no list, until the operator approves it", async () => {
    const wp = await walletProvider();
    const anchor = await s.walletProviders.upload(
      wp.context,
      wp.organisationId,
      wp.serviceId,
      ca("Wallet Co CA"),
    );
    expect(anchor).toMatchObject({ status: "PENDING", kind: "ca" });
    await s.publications.publishAll();
    expect((await listedSubjects()).join()).not.toContain("Wallet Co CA");

    const op = await operator();
    await s.walletProviders.approve(op, anchor.id);
    const subjects = await listedSubjects();
    expect(subjects.join()).toContain("Wallet Co CA");
    expect(subjects.join()).toContain("EUDI dev Wallet Provider");
  });

  it("reaches every hosted PID issuer's engine list when approved", async () => {
    // A hosted issuer, configured before the approval.
    const pid = await s.signUp(undefined, "PID Co");
    const service = await s.certificates.createService(pid.context, pid.organisationId, {
      role: "pid_provider",
      tradeName: "PID Co",
      ...SERVICE,
    });
    await s.issuer?.configure(pid.context, pid.organisationId, service.relyingPartyServiceId, {
      signingVariant: "PID-00",
      registrationVariant: "RC-00",
    });
    expect(harness.verifier.trustLists.at(-1)).toMatchObject({
      issuers: 1,
      providerType: "wallet-provider",
    });

    const wp = await walletProvider();
    const anchor = await s.walletProviders.upload(
      wp.context,
      wp.organisationId,
      wp.serviceId,
      ca("Wallet Co CA"),
    );
    await s.walletProviders.approve(await operator(), anchor.id);
    expect(harness.verifier.trustLists.at(-1)).toMatchObject({
      listId: "wallet-providers",
      issuers: 2,
      providerType: "wallet-provider",
    });
  });

  it("leaves the list when withdrawn, and when its organisation is suspended", async () => {
    const op = await operator();
    const a = await walletProvider("Alpha");
    const b = await walletProvider("Beta");
    const aa = await s.walletProviders.upload(
      a.context,
      a.organisationId,
      a.serviceId,
      ca("Alpha CA"),
    );
    const bb = await s.walletProviders.upload(
      b.context,
      b.organisationId,
      b.serviceId,
      ca("Beta CA"),
    );
    await s.walletProviders.approve(op, aa.id);
    await s.walletProviders.approve(op, bb.id);
    expect((await listedSubjects()).join()).toMatch(/Alpha CA.*Beta CA|Beta CA.*Alpha CA/);

    await s.walletProviders.withdraw(a.context, a.organisationId, a.serviceId, aa.id);
    expect((await listedSubjects()).join()).not.toContain("Alpha CA");

    await s.admin.suspend(op, b.organisationId, "testing suspension");
    expect((await listedSubjects()).join()).not.toContain("Beta CA");
  });

  it("is refused when it carries a private key, is a duplicate, or exceeds two per service", async () => {
    const wp = await walletProvider();
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const key = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(
      await errorCode(
        s.walletProviders.upload(
          wp.context,
          wp.organisationId,
          wp.serviceId,
          `${ca("X")}\n${key}`,
        ),
      ),
    ).toBe("wallet_provider_anchor_contains_private_key");
    const one = ca("One");
    await s.walletProviders.upload(wp.context, wp.organisationId, wp.serviceId, one);
    expect(
      await errorCode(
        s.walletProviders.upload(wp.context, wp.organisationId, wp.serviceId, one),
      ),
    ).toBe("wallet_provider_anchor_duplicate");
    await s.walletProviders.upload(wp.context, wp.organisationId, wp.serviceId, ca("Two"));
    expect(
      await errorCode(
        s.walletProviders.upload(wp.context, wp.organisationId, wp.serviceId, ca("Three")),
      ),
    ).toBe("sandbox_quota_exceeded");
  });

  it("refuses the operator's own EU anchors as a participant's", async () => {
    const wp = await walletProvider();
    const operatorAnchor = toPem(
      s.domain.walletProviderAnchors[0]?.certificate as Buffer,
      "CERTIFICATE",
    );
    expect(
      await errorCode(
        s.walletProviders.upload(wp.context, wp.organisationId, wp.serviceId, operatorAnchor),
      ),
    ).toBe("wallet_provider_anchor_duplicate");
  });
});

describe("who may do what", () => {
  it("lets only an owner upload, only the operator decide, and refuses anchors on other roles", async () => {
    const wp = await walletProvider();
    const { invitationToken } = await s.sandbox.invite(
      wp.context,
      wp.organisationId,
      "member",
      "m@example.test",
    );
    const member = await s.sandbox.createProfile(identity("m@example.test"), {
      displayName: "M",
      invitationToken,
    });
    const memberContext = await s.sandbox.authenticate(member.sessionToken);
    expect(
      await errorCode(
        s.walletProviders.upload(memberContext, wp.organisationId, wp.serviceId, ca("M")),
      ),
    ).toBe("sandbox_owner_required");

    const anchor = await s.walletProviders.upload(
      wp.context,
      wp.organisationId,
      wp.serviceId,
      ca("Owner CA"),
    );
    expect(await errorCode(s.walletProviders.approve(wp.context, anchor.id))).toBe("not_found");
    expect(await errorCode(s.walletProviders.all(wp.context))).toBe("not_found");

    const op = await operator();
    await s.walletProviders.refuse(op, anchor.id, "unknown provider");
    const [refused] = await s.walletProviders.anchors(
      wp.context,
      wp.organisationId,
      wp.serviceId,
    );
    expect(refused).toMatchObject({ status: "REFUSED", reason: "unknown provider" });
    expect(await errorCode(s.walletProviders.approve(op, anchor.id))).toBe(
      "wallet_provider_anchor_not_pending",
    );

    const rp = await s.certificates.createService(wp.context, wp.organisationId, {
      role: "service_provider",
      tradeName: "RP",
      ...SERVICE,
    });
    expect(
      await errorCode(
        s.walletProviders.upload(
          wp.context,
          wp.organisationId,
          rp.relyingPartyServiceId,
          ca("RP"),
        ),
      ),
    ).toBe("sandbox_not_a_wallet_provider");
  });

  it("gives a Wallet Provider service no access or registration certificate", async () => {
    const wp = await walletProvider();
    expect(
      await errorCode(
        s.certificates.issueRegistrationCertificate(
          wp.context,
          wp.organisationId,
          wp.serviceId,
          {
            variant: "RC-00",
          },
        ),
      ),
    ).toBe("sandbox_not_for_wallet_providers");
  });

  it("keeps a Wallet Provider out of the register of wallet-relying parties", async () => {
    const wp = await walletProvider();
    await s.certificates.createService(wp.context, wp.organisationId, {
      role: "service_provider",
      tradeName: "Same org RP",
      ...SERVICE,
    });
    const payload = decodeCompactJws(await s.register.list({})).payload as {
      data: { services: { serviceTradeName: string }[] }[];
    };
    const names = payload.data.flatMap((e) => e.services.map((x) => x.serviceTradeName));
    expect(names).toContain("Same org RP");
    expect(names).not.toContain("Wallet Co Wallet");
  });
});
