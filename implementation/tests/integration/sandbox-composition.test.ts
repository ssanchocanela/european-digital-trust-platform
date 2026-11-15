import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTrustDomain, decodeCompactJws, FileKeyStore } from "@edtp/sandbox-pki";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpApp } from "../../apps/platform-api/src/http-app.js";
import { SandboxTrustDomain } from "../../apps/platform-api/src/modules/sandbox/trust-domain.runtime.js";
import { createHarness, type Harness } from "../support/harness.js";

/**
 * The sandbox as the platform actually composes and serves it — not as the other sandbox tests wire
 * it by hand. Found necessary when two edits to the portal had silently not applied: every piece was
 * tested, the joints were not.
 */
let harness: Harness;
let app: Awaited<ReturnType<typeof createHttpApp>>;
let base: string;
const SECRET = "p".repeat(40);

beforeAll(async () => {
  const store = new FileKeyStore(mkdtempSync(join(tmpdir(), "sbx-comp-")), Buffer.alloc(32, 9));
  const issued = await createTrustDomain(store, new Date("2026-09-10T00:00:00Z"));
  const domain = SandboxTrustDomain.from(
    store,
    new Map(issued.map((i) => [i.member.name, i.certificate])),
  );
  harness = await createHarness({
    sandboxTrustDomain: domain,
    env: {
      PSEUDONYM_MASTER_KEY: Buffer.alloc(32, 3).toString("base64"),
      SANDBOX_PORTAL_SECRET: SECRET,
      SANDBOX_OPERATOR_TENANT_ID: "00000000-0000-4000-8000-000000000001",
      SANDBOX_SIGN_IN_POLICY_ID: "00000000-0000-4000-8000-000000000002",
      SANDBOX_PORTAL_PUBLIC_URL: "https://portal.sandbox.test",
      SANDBOX_PARTICIPANT_TRUST_SOURCES:
        "https://sandbox.test/sandbox/public/lote/PIDProviders.jwt",
      SANDBOX_PKI_DIR: "/not/read/by/the/harness",
      SANDBOX_KEYSTORE_KEY: Buffer.alloc(32, 9).toString("base64"),
      SANDBOX_PUBLIC_BASE_URL: "https://sandbox.test/sandbox/public",
      SANDBOX_VERIFIER_DNS_NAME: "engine.sandbox.test",
      // A laptop without Access: one fixed address (ADR 0018 Decision 7). The real check is
      // tested on its own, against signed assertions.
      SANDBOX_ACCESS_DEV_IDENTITY: "dev@example.test",
    },
  });
  app = await createHttpApp(harness.deps, { quiet: true });
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
  await harness?.close();
});

describe("the composed sandbox", () => {
  it("builds every sandbox service the configuration asks for", () => {
    const s = harness.deps.services;
    expect(s.sandbox).toBeDefined();
    expect(s.sandboxCertificates).toBeDefined();
    expect(s.sandboxPublications).toBeDefined();
    expect(s.sandboxRegister).toBeDefined();
    expect(s.sandboxVerifier).toBeDefined();
    expect(s.sandboxIssuer).toBeDefined();
  });

  it("publishes from the background jobs, and serves the lists, CRLs and status lists publicly", async () => {
    await harness.deps.jobs.runOnce();
    const lote = await fetch(`${base}/sandbox/public/lote/WRPACProviders.jwt`);
    expect(lote.status).toBe(200);
    expect(lote.headers.get("content-type")).toContain("application/jwt");
    expect(decodeCompactJws(await lote.text()).header.typ).toBe("JOSE+JSON");
    const crl = await fetch(`${base}/sandbox/public/crl/access-ca.crl`);
    expect(crl.headers.get("content-type")).toContain("application/pkix-crl");
    expect((await fetch(`${base}/sandbox/public/status/registrar-signing`)).status).toBe(200);
    expect((await fetch(`${base}/sandbox/public/status/unavailable`)).status).toBe(503);
    expect((await fetch(`${base}/sandbox/public/cps`)).status).toBe(200);
    expect(
      (await fetch(`${base}/sandbox/public/ca/registrar.cer`)).headers.get("content-type"),
    ).toContain("pkix-cert");
    expect((await fetch(`${base}/sandbox/public/wrp`)).status).toBe(200);
  });

  it("refuses unknown public names and the portal API without its secret", async () => {
    expect((await fetch(`${base}/sandbox/public/lote/EAAProviders.jwt`)).status).toBe(404);
    // The signed-metadata route is served (S5b), and refuses an engine tenant no sandbox issuer has.
    const metadata = await fetch(
      `${base}/sandbox/public/issuer-metadata/sbx-iss-000000000000`,
      {
        headers: { accept: "application/jwt" },
      },
    );
    expect(metadata.status).toBe(404);
    expect(harness.deps.services.sandboxMetadata).toBeDefined();
    expect((await fetch(`${base}/sandbox/public/ca/keys.cer`)).status).toBe(404);
    expect((await fetch(`${base}/sandbox/v1/me`)).status).toBe(401);
    const wrong = await fetch(`${base}/sandbox/v1/me`, {
      headers: { "x-edtp-sandbox-portal-secret": "x".repeat(40) },
    });
    expect(wrong.status).toBe(401);
  });

  it("routes every portal API family, which answer 401 for a missing session rather than 404", async () => {
    const org = "00000000-0000-4000-8000-0000000000aa";
    const svc = "00000000-0000-4000-8000-0000000000bb";
    for (const path of [
      `organisations/${org}/services`,
      `organisations/${org}/services/${svc}/verifier`,
      `organisations/${org}/services/${svc}/issuer`,
      `organisations/${org}/runs`,
    ]) {
      const res = await fetch(`${base}/sandbox/v1/${path}`, {
        headers: { "x-edtp-sandbox-portal-secret": SECRET },
      });
      expect(res.status, path).toBe(401);
    }
  });
});

describe("the composed sandbox: who is at the portal (ADR 0018)", () => {
  const call = (
    path: string,
    init: { method?: string; session?: string; body?: unknown } = {},
  ) =>
    fetch(`${base}/sandbox/v1/${path}`, {
      method: init.method ?? "GET",
      headers: {
        "x-edtp-sandbox-portal-secret": SECRET,
        "content-type": "application/json",
        ...(init.session ? { "x-edtp-sandbox-session": init.session } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });

  it("enters, creates a profile, and honours the session only for the same address", async () => {
    const entered = await (await call("access/enter", { method: "POST" })).json();
    expect(entered).toEqual({ outcome: "needs_profile", email: "dev@example.test" });
    const created = await call("access/profile", {
      method: "POST",
      body: { displayName: "Dev" },
    });
    expect(created.status).toBe(201);
    const { sessionToken } = (await created.json()) as { sessionToken: string };
    const me = await call("me", { session: sessionToken });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { person: { email: string } }).person.email).toBe(
      "dev@example.test",
    );

    // A session of someone else: the guard ends it, whatever route it is presented to.
    const repo = harness.deps.repositories.sandbox;
    const otherId = "00000000-0000-4000-8000-0000000000cc";
    const now = new Date();
    await repo.createPerson({
      id: otherId as never,
      email: "other@example.test",
      displayName: "Other",
      createdAt: now,
      lastSignInAt: now,
    });
    const otherSession = "o".repeat(43);
    await repo.createSession(otherSession, otherId as never, now);
    expect((await call("me", { session: otherSession })).status).toBe(401);
    expect(
      (
        await call("organisations/00000000-0000-4000-8000-0000000000aa/runs", {
          session: otherSession,
        })
      ).status,
    ).toBe(401);
    expect((await repo.findSession(otherSession))?.endedAt).toBeDefined();
  });
});
