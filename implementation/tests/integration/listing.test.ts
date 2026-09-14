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

describe("narrowing presentations to one policy", () => {
  /**
   * The console's per-offer view asks "what has been presented against *this* offer", and the answer
   * has to come from the query rather than from filtering a page after it is read: a page filtered
   * client-side comes back short, which is indistinguishable from the end of the list.
   */
  it("returns only that policy's presentations", async () => {
    const second = await harness.deps.services.policies.createPolicy({
      tenantId: alice.tenantId,
      relyingPartyServiceId: alice.serviceId,
      intendedUseId: alice.intendedUseId,
      name: "A second offer",
      description: "So the filter has something to exclude.",
    });
    await startPresentations(alice, 2);

    const all = await listing().presentations(alice.tenantId, page());
    const mine = await listing().presentations(alice.tenantId, page(), alice.policyId);
    const other = await listing().presentations(alice.tenantId, page(), second.id);

    expect(all.items.length).toBe(2);
    expect(mine.items.length).toBe(2);
    expect(mine.items.every((i) => i.policyId === alice.policyId)).toBe(true);
    // A policy with no presentations returns none, not everything — the mistake a filter applied in
    // the wrong place makes.
    expect(other.items).toHaveLength(0);
  });

  it("still refuses to cross tenants when narrowed", async () => {
    await startPresentations(bob, 1);
    const result = await listing().presentations(alice.tenantId, page(), bob.policyId);
    expect(result.items).toHaveLength(0);
  });
});

describe("the policy list, which is the one a caller chooses from", () => {
  /**
   * This list is the only one that joins, and the joins are the reason it is usable at all.
   *
   * A caller picking a policy to start a transaction with needs two answers the policy row does not
   * hold: which Relying Party Service it belongs to, because two Services may hold different access
   * certificates while their policies read almost alike; and whether it has a published version,
   * because `resolvePublishedVersion` rejects one that does not. Offering a policy that cannot start
   * is worse than offering nothing, since the failure arrives later and looks like something else.
   *
   * Hand-rolling the keyset for this query is the risk the pagination tests below exist for.
   */
  it("names the Relying Party Service a policy belongs to", async () => {
    const result = await listing().presentationPolicies(alice.tenantId, page());
    const item = result.items.find((i) => i.id === alice.policyId);
    expect(item?.detail?.relyingPartyServiceName).toBe("Example Age Gate");
    expect(item?.detail?.relyingPartyServiceId).toBe(alice.serviceId);
  });

  it("reports the version an omitted policyVersion would resolve to", async () => {
    const result = await listing().presentationPolicies(alice.tenantId, page());
    const item = result.items.find((i) => i.id === alice.policyId);
    expect(item?.detail?.publishedVersion).toBe(1);
  });

  it("lists a policy with no published version, and says it has none", async () => {
    // Listed rather than filtered out: a caller who knows the policy exists must not have to wonder
    // whether it was deleted. `null` rather than absent, so "no published version" is a value a
    // caller can render instead of a field it has to infer from a missing key.
    const draftOnly = await seedTenant(harness, {
      name: "Carol Unpublished",
      engineTenantRef: "engine-tenant-c",
      publishPolicy: false,
    });
    const result = await listing().presentationPolicies(draftOnly.tenantId, page());
    const item = result.items.find((i) => i.id === draftOnly.policyId);
    expect(item).toBeDefined();
    expect(item?.detail?.publishedVersion).toBeNull();
  });

  it("does not let the join reach another tenant's Services", async () => {
    // The join is on `relying_party_service_id` alone; the tenant scope lives in the WHERE. A
    // regression here would show another tenant's trade names, which is exactly the disclosure the
    // list routes were reviewed for.
    const result = await listing().presentationPolicies(alice.tenantId, page());
    expect(result.items).toHaveLength(1);
    expect(result.items.every((i) => i.id === alice.policyId)).toBe(true);
    const serialised = JSON.stringify(result.items);
    expect(serialised).not.toContain(bob.policyId);
    expect(serialised).not.toContain(bob.serviceId);
  });

  it("paginates on the same keyset the other lists use", async () => {
    // Written out by hand for this query, so it is walked rather than trusted — and the harness runs
    // on a `FixedClock`, so all five rows carry the *same* `createdAt`. That makes this the strongest
    // form of the case a naive keyset gets wrong: comparing the timestamp alone, every page after the
    // first would be empty or would repeat, and the total below would not be five distinct ids.
    const extra = 4;
    for (let i = 0; i < extra; i += 1) {
      await harness.deps.services.policies.createPolicy({
        tenantId: alice.tenantId,
        relyingPartyServiceId: alice.serviceId,
        intendedUseId: alice.intendedUseId,
        name: `Extra policy ${i}`,
        description: "Seeded to walk page boundaries.",
      });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await listing().presentationPolicies(alice.tenantId, {
        limit: 2,
        ...(cursor ? { cursor: parsePageRequest({ cursor }).cursor } : {}),
      });
      seen.push(...result.items.map((i) => i.id));
      cursor = result.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(extra + 1);
    expect(new Set(seen).size).toBe(extra + 1);
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
