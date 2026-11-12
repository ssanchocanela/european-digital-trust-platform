import type { AddressInfo } from "node:net";
import type { ApiResult, SandboxApi } from "@edtp/sandbox-portal/api.js";
import {
  BINDING_COOKIE,
  createApp,
  parseCookies,
  readBinding,
  SESSION_COOKIE,
} from "@edtp/sandbox-portal/app.js";
import { escapeHtml, landing, organisationPage } from "@edtp/sandbox-portal/pages.js";
import { afterEach, describe, expect, it } from "vitest";

/** The sandbox portal against a scripted platform API (ADR 0015). */
const ATTEMPT = "11111111-2222-4333-8444-555555555555";
const ORG = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BINDING = "b".repeat(43);
const SESSION = "s".repeat(43);

type Script = (
  method: string,
  path: string,
  options: { session?: string; body?: unknown },
) => ApiResult;

function fakeApi(script: Script) {
  const calls: { method: string; path: string; session?: string; body?: unknown }[] = [];
  const api: SandboxApi = {
    async call(method, path, options = {}) {
      calls.push({ method, path, ...options });
      return script(method, path, options);
    },
  };
  return { api, calls };
}

let close: (() => void) | undefined;
afterEach(() => close?.());

async function serve(script: Script) {
  const { api, calls } = fakeApi(script);
  const app = createApp({ publicUrl: "https://portal.test", api });
  const server = app.listen(0);
  close = () => server.close();
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    fetch(`${base}${path}`, {
      redirect: "manual",
      ...init,
      headers: {
        ...(init.method === "POST"
          ? {
              origin: "https://portal.test",
              "content-type": "application/x-www-form-urlencoded",
            }
          : {}),
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...(init.headers as Record<string, string>),
      },
    });
  return { request, calls };
}

const started: Script = (_m, path) =>
  path === "sign-in-attempts"
    ? {
        status: 201,
        body: {
          attemptId: ATTEMPT,
          bindingToken: BINDING,
          walletUri: "openid4vp://?request_uri=x",
        },
      }
    : { status: 404, body: {} };

describe("pages", () => {
  it("escapes everything it is given", () => {
    expect(escapeHtml(`<script>"x"&'y'</script>`)).toBe(
      "&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;",
    );
    const html = organisationPage({
      id: ORG,
      role: "member",
      localIdentifier: "SB:ES-000001",
      country: "ES",
      members: [{ personId: ORG, displayName: "<img src=x onerror=alert(1)>", role: "member" }],
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("states the modified wallet, synthetic data and the unverified organisation, and claims no conformance", () => {
    const html = landing();
    expect(html).toContain("modified");
    expect(html).toContain("synthetic data");
    expect(html).toContain("not verified");
    expect(html.toLowerCase()).not.toMatch(
      /conformant|compliant|certified|production[- ]ready/,
    );
  });
});

describe("cookies and bindings", () => {
  it("parses only safe cookie values and reads a well-formed binding", () => {
    expect(parseCookies(`a=1; ${BINDING_COOKIE}=x.y; bad=<x>`)).toEqual({
      a: "1",
      [BINDING_COOKIE]: "x.y",
    });
    expect(readBinding(`${ATTEMPT}.sign_up.${BINDING}`)).toEqual({
      attemptId: ATTEMPT,
      purpose: "sign_up",
      token: BINDING,
    });
    expect(readBinding(`${ATTEMPT}.admin.${BINDING}`)).toBeUndefined();
  });
});

describe("the portal", () => {
  it("sends a strict CSP and no-store on every page", async () => {
    const { request } = await serve(started);
    const res = await request("/");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).not.toContain("script-src");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("starts a sign-up: a __Host- binding cookie and a wallet link", async () => {
    const { request, calls } = await serve(started);
    const res = await request("/sign-up/start", {
      method: "POST",
      body: "interaction=SAME_DEVICE",
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${BINDING_COOKIE}=${ATTEMPT}.sign_up.${BINDING}`);
    expect(setCookie).toMatch(/Secure; HttpOnly; SameSite=Lax/);
    expect(await res.text()).toContain('href="openid4vp://?request_uri=x"');
    expect(calls[0]?.body).toEqual({ purpose: "sign_up", interactionType: "SAME_DEVICE" });
  });

  it("shows a QR code that polls, for a cross-device sign-in", async () => {
    const { request } = await serve(started);
    const html = await (
      await request("/sign-in/start", { method: "POST", body: "interaction=QR" })
    ).text();
    expect(html).toContain("<svg");
    expect(html).toContain('content="3;url=/sign-in/wait"');
  });

  it("refuses a form posted from another origin", async () => {
    const { request, calls } = await serve(started);
    const res = await request("/sign-up/start", {
      method: "POST",
      body: "",
      headers: { origin: "https://evil.test" },
    });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("does not complete a sign-in for a browser without the binding, or for another attempt", async () => {
    const { request, calls } = await serve(started);
    expect((await request(`/sign-in/return?attempt=${ATTEMPT}`)).status).toBe(400);
    const other = "99999999-2222-4333-8444-555555555555";
    const res = await request(`/sign-in/return?attempt=${other}`, {
      cookie: `${BINDING_COOKIE}=${ATTEMPT}.sign_in.${BINDING}`,
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("signs in: the session cookie replaces the binding, and the binding token went only to the platform", async () => {
    const { request, calls } = await serve((_m, path) =>
      path.endsWith("/complete")
        ? { status: 200, body: { outcome: "signed_in", sessionToken: SESSION } }
        : { status: 404, body: {} },
    );
    const res = await request(`/sign-in/return?attempt=${ATTEMPT}`, {
      cookie: `${BINDING_COOKIE}=${ATTEMPT}.sign_in.${BINDING}`,
    });
    expect(res.status).toBe(303);
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=${SESSION};`))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${BINDING_COOKIE}=;`))).toBe(true);
    expect(calls[0]).toMatchObject({
      path: `sign-in-attempts/${ATTEMPT}/complete`,
      body: { bindingToken: BINDING },
    });
  });

  it("asks a new person for a profile, and sends the organisation they declare", async () => {
    const { request, calls } = await serve((_m, path) =>
      path.endsWith("/complete")
        ? { status: 200, body: { outcome: "needs_profile" } }
        : path.endsWith("/profile")
          ? { status: 201, body: { sessionToken: SESSION } }
          : { status: 404, body: {} },
    );
    const cookie = `${BINDING_COOKIE}=${ATTEMPT}.sign_up.${BINDING}`;
    const form = await (await request("/sign-in/wait", { cookie })).text();
    expect(form).toContain("Create your account");
    expect(form).toContain("SB:&lt;country&gt;-&lt;number&gt;");
    const res = await request("/sign-in/profile", {
      method: "POST",
      cookie,
      body: "displayName=Ana&legalName=Banco+Ejemplo+S.A.&tradeName=Banco+Ejemplo&country=es",
    });
    expect(res.status).toBe(303);
    expect(calls.at(-1)?.body).toEqual({
      bindingToken: BINDING,
      displayName: "Ana",
      organisation: {
        legalName: "Banco Ejemplo S.A.",
        tradeName: "Banco Ejemplo",
        country: "ES",
        isPublicSectorBody: false,
      },
    });
  });

  it("refuses a malformed invitation link without calling the platform", async () => {
    const { request, calls } = await serve(started);
    expect((await request("/invite/short")).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("shows an invitation link and an API key once, and never the session token", async () => {
    const { request } = await serve((method, path) => {
      if (path === `organisations/${ORG}`)
        return {
          status: 200,
          body: {
            role: "owner",
            organisation: { localIdentifier: "SB:ES-000001", country: "ES" },
          },
        };
      if (path.endsWith("/members"))
        return { status: 200, body: [] as unknown as Record<string, unknown> };
      if (path.endsWith("/api-keys") && method === "GET")
        return { status: 200, body: [] as unknown as Record<string, unknown> };
      if (path.endsWith("/api-keys"))
        return { status: 201, body: { id: ORG, key: "edtp_thekey", label: "ci" } };
      if (path.endsWith("/invitations"))
        return { status: 201, body: { invitationToken: "i".repeat(43) } };
      return { status: 404, body: {} };
    });
    const cookie = `${SESSION_COOKIE}=${SESSION}`;
    const keyPage = await (
      await request(`/org/${ORG}/api-keys`, { method: "POST", cookie, body: "label=ci" })
    ).text();
    expect(keyPage).toContain("edtp_thekey");
    expect(keyPage).toContain("Shown once");
    const invitePage = await (
      await request(`/org/${ORG}/invitations`, { method: "POST", cookie, body: "role=member" })
    ).text();
    expect(invitePage).toContain(`https://portal.test/invite/${"i".repeat(43)}`);
    expect(keyPage + invitePage).not.toContain(SESSION);
  });
});

describe("services and certificates (S3)", () => {
  const SERVICE = "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const CERT = "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  it("parses claim paths: dots, * for any array element, digits for an index", async () => {
    const { parseClaimLines } = await import("@edtp/sandbox-portal/pages.js");
    expect(parseClaimLines("given_name\n address.locality \nnationalities.*\nx.0\n\n")).toEqual(
      [["given_name"], ["address", "locality"], ["nationalities", null], ["x", 0]],
    );
  });

  it("says on a certificate page that the sandbox's check is not a wallet's verdict, and escapes it", async () => {
    const { certificatePage } = await import("@edtp/sandbox-portal/pages.js");
    const html = certificatePage(ORG, {
      id: CERT,
      kind: "WRPRC",
      variant: "RC-12",
      variantTitle: "<b>x</b>",
      requirement: "AS-AP-44-007 (RPRC_23)",
      createdAt: "2026-11-12",
      issuanceSide: true,
      selfTest: { fails: ["provides_attestation"], asDesigned: true },
    });
    expect(html).toContain("not a wallet's verdict");
    expect(html).toContain("Checked at issuance only");
    expect(html).toContain("— as designed");
    expect(html).not.toContain("<b>x</b>");
  });

  it("sends a CSR and the DNS names it was given, and lands on the issued certificate", async () => {
    const { request, calls } = await serve((_m, path) =>
      path.endsWith("/access-certificates")
        ? { status: 201, body: { id: CERT } }
        : { status: 404, body: {} },
    );
    const res = await request(`/org/${ORG}/services/${SERVICE}/access-certificates`, {
      method: "POST",
      cookie: `${SESSION_COOKIE}=${SESSION}`,
      body: new URLSearchParams({
        variant: "AC-02",
        csrPem: "-----BEGIN CERTIFICATE REQUEST-----",
        dnsNames: "a.test\nb.test",
      }).toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/org/${ORG}/certificates/${CERT}`);
    expect(calls[0]?.body).toEqual({
      variant: "AC-02",
      csrPem: "-----BEGIN CERTIFICATE REQUEST-----",
      dnsNames: ["a.test", "b.test"],
    });
  });

  it("downloads a certificate as a file, and refuses one with no body", async () => {
    const { request } = await serve((_m, path) =>
      path === `organisations/${ORG}/certificates/${CERT}`
        ? { status: 200, body: { kind: "WRPRC", variant: "RC-00", body: "eyJ.x.y" } }
        : { status: 200, body: { kind: "WRPRC", variant: "RC-01" } },
    );
    const res = await request(`/org/${ORG}/certificates/${CERT}/download`, {
      cookie: `${SESSION_COOKIE}=${SESSION}`,
    });
    expect(res.headers.get("content-disposition")).toContain(
      'filename="wrprc-RC-00-dddddddd.jwt"',
    );
    expect(await res.text()).toBe("eyJ.x.y");
    const other = "eeeeeeee-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(
      (
        await request(`/org/${ORG}/certificates/${other}/download`, {
          cookie: `${SESSION_COOKIE}=${SESSION}`,
        })
      ).status,
    ).toBe(404);
  });
});

describe("the hosted verifier and runs (S4)", () => {
  const SERVICE = "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const USE = "abababab-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const RUN = "cdcdcdcd-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const cookie = `${SESSION_COOKIE}=${SESSION}`;

  it("configures from one variant per intended use, read from the rc_<id> fields", async () => {
    const { request, calls } = await serve((_m, path) =>
      path.endsWith("/verifier")
        ? { status: 200, body: { configured: true } }
        : { status: 404, body: {} },
    );
    const res = await request(`/org/${ORG}/services/${SERVICE}/verifier`, {
      method: "POST",
      cookie,
      body: new URLSearchParams({
        accessVariant: "AC-02",
        [`rc_${USE}`]: "RC-06",
        rc_bad: "RC-00",
      }).toString(),
    });
    expect(res.status).toBe(303);
    expect(calls[0]?.body).toEqual({
      accessVariant: "AC-02",
      uses: [{ intendedUseId: USE, registrationVariant: "RC-06" }],
    });
  });

  it("starts a cross-device run whose page polls the run report", async () => {
    const { request } = await serve((_m, path) =>
      path.endsWith("/runs")
        ? { status: 201, body: { runId: RUN, walletUri: "openid4vp://?x" } }
        : { status: 404, body: {} },
    );
    const html = await (
      await request(`/org/${ORG}/services/${SERVICE}/runs`, {
        method: "POST",
        cookie,
        body: `intendedUseId=${USE}&interaction=QR`,
      })
    ).text();
    expect(html).toContain(`content="3;url=/org/${ORG}/runs/${RUN}"`);
    expect(html).toContain("<svg");
  });

  it("asks for the wallet build and the Check Registration Certificates position, and says no value belongs in the note", async () => {
    const { runPage } = await import("@edtp/sandbox-portal/pages.js");
    const cert = {
      id: RUN,
      kind: "WRPRC",
      variant: "RC-06",
      variantTitle: "Not bound",
      requirement: "EW-DM-44-020 (RPRC_17a)",
      createdAt: "x",
    };
    const html = runPage(ORG, {
      id: RUN,
      createdAt: "2026-11-12",
      interaction: "SAME_DEVICE",
      outcome: { status: "AWAITING_WALLET" },
      accessCertificate: { ...cert, kind: "WRPAC", variant: "AC-00" },
      registrationCertificate: cert,
      expected: {
        access: { variant: "AC-00", requirement: "—" },
        registration: {
          variant: "RC-06",
          requirement: "EW-DM-44-020 (RPRC_17a)",
          registrationCheck: true,
        },
      },
      observation: {},
    });
    expect(html).toContain('name="checkRegistrationCertificates"');
    expect(html).toContain("No credential value belongs in the note");
    expect(html).toContain("only with <strong>Check Registration Certificates</strong> on");
    expect(html).toContain('http-equiv="refresh"');
  });

  it("sanitises an observation before sending it", async () => {
    const { request, calls } = await serve(() => ({ status: 204, body: {} }));
    await request(`/org/${ORG}/runs/${RUN}/observation`, {
      method: "POST",
      cookie,
      body: new URLSearchParams({
        walletBuild: "W",
        checkRegistrationCertificates: "maybe",
        observation: "made_up",
        note: "  n  ",
      }).toString(),
    });
    expect(calls[0]?.body).toEqual({
      walletBuild: "W",
      checkRegistrationCertificates: "unknown",
      observation: "other",
      note: "n",
    });
  });

  it("offers no issuance-side variant to the hosted verifier", async () => {
    const { verifierSection } = await import("@edtp/sandbox-portal/pages.js");
    const html = verifierSection({
      orgId: ORG,
      serviceId: SERVICE,
      intendedUses: [{ id: USE, intendedUseIdentifier: "S001-U01" }],
      verifier: { configured: false },
      wrpacVariants: [{ id: "AC-00", title: "Correct", requirement: "—" }],
      wrprcVariants: [
        { id: "RC-00", title: "Correct", requirement: "—" },
        { id: "RC-11", title: "Wrong entitlement", requirement: "x", issuanceSide: true },
      ],
    });
    expect(html).toContain('value="RC-00"');
    expect(html).not.toContain('value="RC-11"');
  });
});

describe("the hosted PID issuer (S5)", () => {
  const SERVICE = "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const ISS = "efefefef-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const cookie = `${SESSION_COOKIE}=${SESSION}`;

  it("sends the typed synthetic values normalised, and shows the offer as a QR code that polls the issuance", async () => {
    const { request, calls } = await serve((_m, path) =>
      path.endsWith("/issuer/offers")
        ? {
            status: 201,
            body: { id: ISS, offerUri: "openid-credential-offer://?credential_offer_uri=x" },
          }
        : { status: 404, body: {} },
    );
    const html = await (
      await request(`/org/${ORG}/services/${SERVICE}/issuer/offers`, {
        method: "POST",
        cookie,
        body: new URLSearchParams({
          givenName: "Zelda",
          familyName: "Quintanilla",
          birthdate: "1991-02-03",
          birthCountry: "es",
          nationalities: "es, pt",
          interaction: "QR",
        }).toString(),
      })
    ).text();
    expect(calls[0]?.body).toEqual({
      givenName: "Zelda",
      familyName: "Quintanilla",
      birthdate: "1991-02-03",
      birthCountry: "ES",
      nationalities: ["ES", "PT"],
    });
    expect(html).toContain("<svg");
    expect(html).toContain(`content="3;url=/org/${ORG}/issuances/${ISS}"`);
  });

  it("says which wallet build exercises the issuance-side checks, offers them, and insists on synthetic data", async () => {
    const { issuerSection } = await import("@edtp/sandbox-portal/pages.js");
    const html = issuerSection({
      orgId: ORG,
      serviceId: SERVICE,
      issuer: {
        configured: true,
        signingCertificate: {
          id: "x",
          variant: "PID-00",
          variantTitle: "Correct",
          requirement: "—",
        },
        issuances: [],
      },
      signingVariants: [{ id: "PID-00", title: "Correct", requirement: "—" }],
      wrprcVariants: [
        { id: "RC-00", title: "Correct", requirement: "—" },
        { id: "RC-12", title: "Not registered", requirement: "x", issuanceSide: true },
      ],
    });
    expect(html).toContain("<code>sandbox-strict</code> wallet build");
    expect(html).toContain("Synthetic data only");
    expect(html).toContain('value="RC-12"');
    expect(html).toContain("(checked at issuance only)");
  });

  it("offers revocation only for a revocable PID, and refreshes until settled", async () => {
    const { issuancePage } = await import("@edtp/sandbox-portal/pages.js");
    const pending = issuancePage(ORG, {
      id: ISS,
      status: "AWAITING_WALLET",
      revocable: false,
      signingCertificate: { variant: "PID-01", variantTitle: "x", requirement: "ISSU_07" },
    });
    expect(pending).toContain('http-equiv="refresh"');
    expect(pending).not.toContain("/revoke");
    const issued = issuancePage(ORG, {
      id: ISS,
      status: "ISSUED",
      revocable: true,
      signingCertificate: { variant: "PID-00", variantTitle: "x", requirement: "—" },
    });
    expect(issued).not.toContain('http-equiv="refresh"');
    expect(issued).toContain(`/org/${ORG}/issuances/${ISS}/revoke`);
  });
});

describe("the service page, end to end through its route", () => {
  const SERVICE = "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const USE = "abababab-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const cookie = `${SESSION_COOKIE}=${SESSION}`;

  // Found when an edit meant to add the hosted verifier to this page had not applied: the section and
  // its routes were each tested, the page that joins them was not.
  const script =
    (role: string, hosted: "verifier" | "issuer" | "none") => (_m: string, path: string) => {
      if (path === `organisations/${ORG}/services/${SERVICE}`) {
        return {
          status: 200,
          body: {
            relyingPartyServiceId: SERVICE,
            serviceIdentifier: "S001",
            serviceTradeName: "Svc",
            role,
            intendedUses: [
              {
                id: USE,
                intendedUseIdentifier: "S001-U01",
                purpose: [{ lang: "en", value: "p" }],
              },
            ],
          },
        };
      }
      if (path.startsWith(`organisations/${ORG}/certificates`))
        return { status: 200, body: [] as unknown as Record<string, unknown> };
      if (path.endsWith("/verifier") && hosted === "verifier")
        return { status: 200, body: { configured: false } };
      if (path.endsWith("/issuer") && hosted === "issuer")
        return { status: 200, body: { configured: false } };
      return { status: 404, body: {} };
    };

  it("shows a Relying Party service its hosted verifier", async () => {
    const { request } = await serve(script("service_provider", "verifier"));
    const html = await (await request(`/org/${ORG}/services/${SERVICE}`, { cookie })).text();
    expect(html).toContain("<h2>Hosted verifier</h2>");
    expect(html).toContain(`name="rc_${USE}"`);
  });

  it("shows a PID Provider service its hosted issuer", async () => {
    const { request } = await serve(script("pid_provider", "issuer"));
    const html = await (await request(`/org/${ORG}/services/${SERVICE}`, { cookie })).text();
    expect(html).toContain("<h2>Hosted PID issuer</h2>");
    expect(html).toContain('name="signingVariant"');
  });

  it("leaves the section out when the platform does not offer it", async () => {
    const { request } = await serve(script("service_provider", "none"));
    const html = await (await request(`/org/${ORG}/services/${SERVICE}`, { cookie })).text();
    expect(html).not.toContain("Hosted verifier");
  });
});

describe("the organisation page, end to end through its route", () => {
  const RUN = "cdcdcdcd-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  it("lists the organisation's services and runs", async () => {
    const { request } = await serve((_m, path) => {
      if (path === `organisations/${ORG}`)
        return {
          status: 200,
          body: {
            role: "member",
            organisation: { localIdentifier: "SB:ES-000001", country: "ES" },
          },
        };
      if (path.endsWith("/members"))
        return { status: 200, body: [] as unknown as Record<string, unknown> };
      if (path.endsWith("/services"))
        return { status: 200, body: [] as unknown as Record<string, unknown> };
      if (path.endsWith("/runs"))
        return {
          status: 200,
          body: [
            { id: RUN, createdAt: "2026-11-12", interaction: "QR", observed: false },
          ] as unknown as Record<string, unknown>,
        };
      return { status: 404, body: {} };
    });
    const html = await (
      await request(`/org/${ORG}`, { cookie: `${SESSION_COOKIE}=${SESSION}` })
    ).text();
    expect(html).toContain("<h2>Services</h2>");
    expect(html).toContain(`/org/${ORG}/runs/${RUN}`);
  });
});
