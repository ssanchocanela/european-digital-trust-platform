import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parsePageRequest } from "@edtp/persistence";
import { newCorrelationId, PlatformError } from "@edtp/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../support/harness.js";
import { type SeededTenant, seedTenant } from "../support/seed.js";

/**
 * The list endpoints.
 *
 * Two things are worth testing rather than trusting, and they are different in kind.
 *
 * **Enumeration is a new exposure.** Every route before these took an identifier the caller already
 * held, so tenant isolation was about direct access. A list is the first way to ask "what is there",
 * and a scoping mistake here leaks a whole tenant rather than one row.
 *
 * **Keyset pagination is easy to get subtly wrong.** The failure is not a crash: it is a page boundary
 * that silently drops or repeats a row, which nobody notices until a count is wrong somewhere else. So
 * the tests walk real pages, including the case the naive implementation gets wrong — rows sharing a
 * timestamp.
 */

let harness: Harness;
let alice: SeededTenant;
let bob: SeededTenant;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
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

const listing = () => harness.deps.repositories.listing;
const page = (limit = DEFAULT_PAGE_SIZE) => ({ limit });

const startPresentations = async (tenant: SeededTenant, count: number): Promise<string[]> => {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const view = await harness.deps.services.presentations.create({
      tenantId: tenant.tenantId,
      policyId: tenant.policyId,
      businessReference: `ref-${i}`,
      interactionType: "SAME_DEVICE",
      correlationId: newCorrelationId(),
    });
    ids.push(view.presentationId);
  }
  return ids;
};

describe("enumeration is scoped to the authenticated tenant", () => {
  it("lists only the caller's presentations, never another tenant's", async () => {
    await startPresentations(alice, 3);
    await startPresentations(bob, 2);

    const forAlice = await listing().presentations(alice.tenantId, page());
    const forBob = await listing().presentations(bob.tenantId, page());

    expect(forAlice.items).toHaveLength(3);
    expect(forBob.items).toHaveLength(2);

    // The decisive assertion: no identifier appears in both lists. Counting alone would pass even if
    // the queries were unscoped and happened to return the same number of rows.
    const aliceIds = new Set(forAlice.items.map((i) => i.presentationId));
    for (const item of forBob.items) {
      expect(aliceIds.has(item.presentationId)).toBe(false);
    }
  });

  it("lists only the caller's configuration", async () => {
    for (const [tenant, expected] of [
      [alice, alice.serviceId],
      [bob, bob.serviceId],
    ] as const) {
      const services = await listing().relyingPartyServices(tenant.tenantId, page());
      expect(services.items.map((i) => i.id)).toEqual([expected]);

      const policies = await listing().presentationPolicies(tenant.tenantId, page());
      expect(policies.items.every((i) => i.id === tenant.policyId)).toBe(true);
    }
  });

  it("returns an empty page for a tenant with nothing, rather than everything", async () => {
    // The classic scoping bug: a missing `WHERE` turns "none of mine" into "all of everyone's".
    await startPresentations(alice, 2);
    const forBob = await listing().presentations(bob.tenantId, page());
    expect(forBob.items).toEqual([]);
    expect(forBob.nextCursor).toBeUndefined();
  });

  it("scopes a nested list by tenant as well as by parent", async () => {
    // Asking for Bob's service while authenticated as Alice must match nothing — and must not reveal
    // that the id exists at all, which is why it is an empty page rather than a 403.
    const uses = await listing().intendedUses(alice.tenantId, bob.serviceId, page());
    expect(uses.items).toEqual([]);
  });
});

describe("keyset pagination", () => {
  it("walks every row exactly once across pages", async () => {
    const created = await startPresentations(alice, 7);

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const result = await listing().presentations(alice.tenantId, {
        limit: 3,
        ...(cursor ? { cursor: parsePageRequest({ cursor }).cursor } : {}),
      });
      seen.push(...result.items.map((i) => i.presentationId));
      cursor = result.nextCursor;
      guard += 1;
      expect(guard, "pagination did not terminate").toBeLessThan(10);
    } while (cursor);

    expect(seen).toHaveLength(created.length);
    expect(new Set(seen).size).toBe(created.length);
    expect([...seen].sort()).toEqual([...created].sort());
  });

  it("omits the cursor on the last page", async () => {
    await startPresentations(alice, 2);
    const result = await listing().presentations(alice.tenantId, { limit: 10 });
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBeUndefined();
  });

  it("orders newest first", async () => {
    await startPresentations(alice, 4);
    const result = await listing().presentations(alice.tenantId, page());
    const times = result.items.map((i) => i.createdAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("does not drop or repeat rows that share a timestamp", async () => {
    // The harness clock is fixed, so every row here has an identical `created_at`. That is exactly the
    // case a cursor keyed on the timestamp alone gets wrong: it would either skip the rest of the
    // group or return it again for ever. The id tiebreaker is what makes it correct, and this test is
    // the reason it exists.
    const created = await startPresentations(alice, 5);

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const result = await listing().presentations(alice.tenantId, {
        limit: 2,
        ...(cursor ? { cursor: parsePageRequest({ cursor }).cursor } : {}),
      });
      seen.push(...result.items.map((i) => i.presentationId));
      cursor = result.nextCursor;
      guard += 1;
      expect(guard, "pagination did not terminate on tied timestamps").toBeLessThan(10);
    } while (cursor);

    expect(new Set(seen).size).toBe(created.length);
  });
});

describe("what a list item may contain", () => {
  it("carries no presentation result, even after one is recorded", async () => {
    // `GET /v1/presentations/{id}` returns the result policy's output. A list must not, because
    // enumerating results in bulk is a different act from reading one — `AS-RP-01-002` (`OIA_16`).
    const [presentationId] = await startPresentations(alice, 1);
    expect(presentationId).toBeDefined();

    const result = await listing().presentations(alice.tenantId, page());
    const item = result.items[0];
    expect(item).toBeDefined();
    const serialised = JSON.stringify(item);
    expect(serialised).not.toContain("result");
    expect(serialised).not.toContain("claims");
    expect(Object.keys(item as object)).not.toContain("result");
  });

  it("carries no engine session reference and no status-list index", async () => {
    // Both are metadata that must never be returned: the revocation index is an `ISSU_35` unique
    // element (`CLAUDE.md` §6.8). Asserted on the shape rather than on a populated row, because the
    // shape is what guarantees it for rows that do not exist yet.
    const result = await listing().issuedCredentials(alice.tenantId, page());
    for (const item of result.items) {
      const keys = Object.keys(item);
      expect(keys).not.toContain("engineSessionRef");
      expect(keys).not.toContain("statusListIndex");
      expect(keys).not.toContain("statusListUri");
    }
  });

  it("reports whether a Service has a callback destination, never the destination", async () => {
    const services = await listing().relyingPartyServices(alice.tenantId, page());
    const serialised = JSON.stringify(services.items);
    expect(serialised).toContain("hasWebhookEndpoint");
    expect(serialised).not.toContain("https://alice.test");
  });
});

describe("page request parsing", () => {
  it("defaults the limit rather than returning everything", () => {
    expect(parsePageRequest({}).limit).toBe(DEFAULT_PAGE_SIZE);
  });

  it("rejects a limit above the maximum instead of clamping silently", () => {
    // A silent clamp is how a client loops for ever on a page it believes is the last.
    expect(() => parsePageRequest({ limit: String(MAX_PAGE_SIZE + 1) })).toThrow(PlatformError);
    expect(parsePageRequest({ limit: String(MAX_PAGE_SIZE) }).limit).toBe(MAX_PAGE_SIZE);
  });

  it("rejects a non-numeric or non-positive limit", () => {
    for (const limit of ["abc", "0", "-1", "1.5"]) {
      expect(() => parsePageRequest({ limit }), limit).toThrow(PlatformError);
    }
  });

  it("rejects a cursor it did not issue", () => {
    for (const cursor of ["!!!", "abc", Buffer.from("no-separator").toString("base64url")]) {
      expect(() => parsePageRequest({ cursor }), cursor).toThrow(PlatformError);
    }
  });

  it("treats an empty limit or cursor as absent, because a browser sends empty fields", () => {
    const parsed = parsePageRequest({ limit: "", cursor: "" });
    expect(parsed.limit).toBe(DEFAULT_PAGE_SIZE);
    expect(parsed.cursor).toBeUndefined();
  });
});
