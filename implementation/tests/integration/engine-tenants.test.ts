import { EngineCredentialRepository } from "@edtp/persistence";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EngineTenantService } from "../../apps/platform-api/src/modules/engine-tenants/engine-tenant.service.js";
import { createHarness, type Harness } from "../support/harness.js";

/** Engine tenants created at runtime and their sealed clients (sandbox G-6). */
let harness: Harness;
let repository: EngineCredentialRepository;
const key = Buffer.alloc(32, 9);

beforeAll(async () => {
  harness = await createHarness();
  repository = new EngineCredentialRepository(harness.handle.db, key);
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  await harness.handle.pool.query("TRUNCATE engine_tenant_credentials");
});

describe("EngineCredentialRepository", () => {
  it("seals the secret: the database holds no plaintext, and the client reads back", async () => {
    await repository.save({
      engineTenantRef: "sbx-rp-one",
      clientId: "client-one",
      clientSecret: "the-secret-value",
      createdAt: harness.clock.now(),
    });
    const { rows } = await harness.handle.pool.query("SELECT * FROM engine_tenant_credentials");
    expect(JSON.stringify(rows)).not.toContain("the-secret-value");
    expect(await repository.find("sbx-rp-one")).toEqual({
      clientId: "client-one",
      clientSecret: "the-secret-value",
    });
  });

  it("does not open a sealed secret moved onto another tenant's row", async () => {
    for (const ref of ["sbx-rp-one", "sbx-rp-two"]) {
      await repository.save({
        engineTenantRef: ref,
        clientId: ref,
        clientSecret: `secret-${ref}`,
        createdAt: harness.clock.now(),
      });
    }
    await harness.handle.pool.query(
      `UPDATE engine_tenant_credentials SET client_secret_sealed =
         (SELECT client_secret_sealed FROM engine_tenant_credentials WHERE engine_tenant_ref = 'sbx-rp-one')
       WHERE engine_tenant_ref = 'sbx-rp-two'`,
    );
    await expect(repository.find("sbx-rp-two")).rejects.toThrow();
  });

  it("does not open under another key", async () => {
    await repository.save({
      engineTenantRef: "sbx-rp-one",
      clientId: "c",
      clientSecret: "s",
      createdAt: harness.clock.now(),
    });
    await expect(
      new EngineCredentialRepository(harness.handle.db, Buffer.alloc(32, 1)).find("sbx-rp-one"),
    ).rejects.toThrow();
  });
});

describe("EngineTenantService", () => {
  function service() {
    const created: string[] = [];
    const port = {
      createEngineTenant: async (input: { engineTenantRef: string; name: string }) => {
        created.push(input.engineTenantRef);
        return { clientId: `client-${input.engineTenantRef}`, clientSecret: "fresh-secret" };
      },
    };
    return {
      created,
      service: new EngineTenantService(
        port,
        repository,
        harness.verifier,
        harness.clock,
        harness.deps.logger,
        120,
      ),
    };
  }

  it("creates, stores the client sealed, and asserts minimal retention before handing the tenant out", async () => {
    const { service: s, created } = service();
    const ref = EngineTenantService.newRef("sbx-rp");
    expect(ref).toMatch(/^sbx-rp-[a-z0-9]{12}$/);
    await s.create(ref, "Banco Ejemplo");
    expect(created).toEqual([ref]);
    expect(await repository.find(ref)).toEqual({
      clientId: `client-${ref}`,
      clientSecret: "fresh-secret",
    });
    expect(harness.verifier.retentionCalls).toEqual([
      { engineTenantRef: ref, settings: { sessionTtlSeconds: 120, cleanupMode: "ANONYMIZE" } },
    ]);
    expect(harness.logs.lines.join("\n")).not.toContain("fresh-secret");
  });

  it("refuses to create a tenant it already holds", async () => {
    const { service: s } = service();
    await s.create("sbx-rp-dup000000000", "x");
    await expect(s.create("sbx-rp-dup000000000", "x")).rejects.toThrow(/already exists/);
  });
});
