import { hashApiKey } from "@edtp/persistence";
import { asId, newCorrelationId } from "@edtp/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../support/harness.js";
import { type SeededTenant, seedTenant } from "../support/seed.js";

/**
 * Tenant isolation.
 *
 * The V0 plan requires tests proving cross-tenant access is rejected. The mechanism is that
 * `tenant_id` is part of every query predicate, so another tenant's row is not "forbidden"
 * — it is invisible, and the caller gets a 404. These tests assert that at the service and
 * repository layer, which is where the property actually lives.
 */
let harness: Harness;
let alice: SeededTenant;
let bob: SeededTenant;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  // Guarded: if `beforeAll` failed, the harness is undefined and an unguarded close would
  // mask the real cause with a TypeError.
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  alice = await seedTenant(harness, {
    name: "Alice Retail",
    engineTenantRef: "engine-tenant-a",
  });
  bob = await seedTenant(harness, { name: "Bob Services", engineTenantRef: "engine-tenant-b" });
});

const correlationId = () => newCorrelationId();

describe("cross-tenant reads", () => {
  it("hides another tenant's policy", async () => {
    await expect(
      harness.deps.services.policies.getPolicy(bob.tenantId, alice.policyId),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });

  it("hides another tenant's Relying Party Service", async () => {
    await expect(
      harness.deps.services.registration.getService(bob.tenantId, alice.serviceId),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });

  it("hides another tenant's presentation transaction", async () => {
    const created = await harness.deps.services.presentations.create({
      tenantId: alice.tenantId,
      policyId: alice.policyId,
      businessReference: "alice-order-1",
      correlationId: correlationId(),
    });

    await expect(
      harness.deps.services.presentations.get(
        bob.tenantId,
        created.presentationId,
        correlationId(),
      ),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });

    // Alice can still read it, so the rejection is isolation rather than a broken lookup.
    const mine = await harness.deps.services.presentations.get(
      alice.tenantId,
      created.presentationId,
      correlationId(),
    );
    expect(mine.presentationId).toBe(created.presentationId);
  });

  it("hides another tenant's presentation result", async () => {
    const created = await harness.deps.services.presentations.create({
      tenantId: alice.tenantId,
      policyId: alice.policyId,
      businessReference: "alice-order-2",
      correlationId: correlationId(),
    });
    harness.verifier.settleVerified("engine-session-1", { birthdate: "1990-05-17" });
    await harness.deps.services.presentations.get(
      alice.tenantId,
      created.presentationId,
      correlationId(),
    );

    const asBob = await harness.deps.repositories.transactions.findResult(
      bob.tenantId,
      created.presentationId,
    );
    expect(asBob).toBeUndefined();

    const asAlice = await harness.deps.repositories.transactions.findResult(
      alice.tenantId,
      created.presentationId,
    );
    expect(asAlice?.claims).toEqual({ over_18: true });
  });

  it("hides another tenant's intended use and access certificate", async () => {
    expect(
      await harness.deps.repositories.registration.findIntendedUse(
        bob.tenantId,
        asId<"IntendedUseId">(alice.intendedUseId),
      ),
    ).toBeUndefined();

    expect(
      await harness.deps.repositories.registration.findAccessCertificateForService(
        bob.tenantId,
        alice.serviceId,
      ),
    ).toBeUndefined();
  });

  it("hides another tenant's webhook signing secret", async () => {
    // The secret signs outbound callbacks. Leaking it across tenants would let one tenant
    // forge another's result notifications.
    expect(
      await harness.deps.repositories.registration.findWebhookSecret(
        bob.tenantId,
        alice.serviceId,
      ),
    ).toBeUndefined();
    expect(
      await harness.deps.repositories.registration.findWebhookSecret(
        alice.tenantId,
        alice.serviceId,
      ),
    ).toBe(alice.webhookSecret);
  });

  it("hides another tenant's audit events", async () => {
    const created = await harness.deps.services.presentations.create({
      tenantId: alice.tenantId,
      policyId: alice.policyId,
      businessReference: "alice-order-3",
      correlationId: correlationId(),
    });

    expect(
      await harness.deps.services.audit.listForPresentation(
        bob.tenantId,
        created.presentationId,
      ),
    ).toHaveLength(0);
    expect(
      (
        await harness.deps.services.audit.listForPresentation(
          alice.tenantId,
          created.presentationId,
        )
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe("cross-tenant writes", () => {
  it("refuses to create a policy against another tenant's Service", async () => {
    await expect(
      harness.deps.services.policies.createPolicy({
        tenantId: bob.tenantId,
        relyingPartyServiceId: alice.serviceId,
        intendedUseId: asId<"IntendedUseId">(alice.intendedUseId),
        name: "Borrowed",
        description: "Attempts to use another tenant's Service.",
      }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });

  it("refuses to create a policy version on another tenant's policy", async () => {
    await expect(
      harness.deps.services.policies.createVersion({
        tenantId: bob.tenantId,
        policyId: alice.policyId,
        purpose: [{ lang: "en", value: "Borrowed purpose" }],
        credentialRequirements: [
          { credentialType: "urn:eudi:pid:1", acceptedFormats: ["dc+sd-jwt"] },
        ],
        requestedClaims: [{ path: ["birthdate"] }],
        resultPolicy: { kind: "VERIFIED_CLAIMS", allowedClaims: [["birthdate"]] },
      }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });

  it("refuses to create a presentation against another tenant's policy", async () => {
    await expect(
      harness.deps.services.presentations.create({
        tenantId: bob.tenantId,
        policyId: alice.policyId,
        businessReference: "bob-borrows-alice",
        correlationId: correlationId(),
      }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });

  it("refuses to cancel another tenant's presentation", async () => {
    const created = await harness.deps.services.presentations.create({
      tenantId: alice.tenantId,
      policyId: alice.policyId,
      businessReference: "alice-order-4",
      correlationId: correlationId(),
    });

    await expect(
      harness.deps.services.presentations.cancel(
        bob.tenantId,
        created.presentationId,
        correlationId(),
      ),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });

    // Still open, so the refusal did not partially apply.
    const view = await harness.deps.services.presentations.get(
      alice.tenantId,
      created.presentationId,
      correlationId(),
    );
    expect(view.status).toBe("AWAITING_WALLET");
  });

  it("refuses to provision an instance on another tenant's Service", async () => {
    await expect(
      harness.deps.services.registration.provisionInstance({
        tenantId: bob.tenantId,
        relyingPartyServiceId: alice.serviceId,
        engineTenantRef: "engine-tenant-b",
        trustEnvironment: "TEST",
        accessCertificate: { privateKeyJwk: { kty: "EC" }, certificateChain: ["pem"] },
      }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });
});

describe("API key resolution", () => {
  it("resolves each key to its own tenant and nothing else", async () => {
    expect(await harness.deps.repositories.apiKeys.resolveTenant(alice.apiKey)).toBe(
      alice.tenantId,
    );
    expect(await harness.deps.repositories.apiKeys.resolveTenant(bob.apiKey)).toBe(
      bob.tenantId,
    );
  });

  it("rejects an unknown key", async () => {
    expect(
      await harness.deps.repositories.apiKeys.resolveTenant("edtp_not-a-real-key-value-at-all"),
    ).toBeUndefined();
  });

  it("rejects a key with a valid prefix but a wrong remainder", async () => {
    // The prefix is only an index lookup; the hash comparison is what authenticates. A key
    // sharing a prefix must not be accepted.
    const forged = `${alice.apiKey.slice(0, 12)}${"x".repeat(alice.apiKey.length - 12)}`;
    expect(await harness.deps.repositories.apiKeys.resolveTenant(forged)).toBeUndefined();
  });

  it("stores only a hash, so a database dump yields no usable credential", async () => {
    const { rows } = await harness.handle.pool.query<{ key_hash: string; key_prefix: string }>(
      'SELECT "key_hash", "key_prefix" FROM "api_keys" WHERE "tenant_id" = $1',
      [alice.tenantId],
    );
    const row = rows[0];
    expect(row?.key_hash).toBe(hashApiKey(alice.apiKey));
    expect(row?.key_hash).not.toContain(alice.apiKey);
    // The stored prefix is short and non-secret; the full key never appears.
    expect(row?.key_prefix).toBe(alice.apiKey.slice(0, 12));
  });
});
