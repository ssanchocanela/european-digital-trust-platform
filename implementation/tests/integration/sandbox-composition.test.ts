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
