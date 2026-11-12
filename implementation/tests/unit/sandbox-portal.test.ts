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
