import { randomUUID } from "node:crypto";
import { tables } from "@edtp/persistence";
import { asId } from "@edtp/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asPostgresError } from "../../apps/platform-api/src/http/error.filter.js";
import { createHarness, type Harness } from "../support/harness.js";

/**
 * A constraint violation must reach the caller as a conflict, not as a `500`.
 *
 * `CLAUDE.md` §6.15 says so, and it had stopped being true. Drizzle 0.44 does not rethrow the `pg`
 * error: it throws `Error: Failed query: insert into …` and hangs the original off `cause`. The
 * filter read `code` from the exception itself, found nothing, and every integrity violation fell
 * through to the unhandled branch as `internal_error` — the outcome the translation exists to
 * prevent.
 *
 * So this test provokes a **real** duplicate insert through the real driver. A test that built
 * `{code: "23505"}` by hand would have passed throughout the regression, and would pass again the
 * next time the driver changes how it wraps.
 */
let harness: Harness;

beforeEach(async () => {
  harness ??= await createHarness();
  await harness.reset();
});

afterAll(async () => {
  await harness?.close();
});

describe("integrity violations survive the driver's wrapping", () => {
  const duplicateTenantInsert = async (): Promise<unknown> => {
    const id = asId<"TenantId">(randomUUID());
    const row = { id, name: "Duplicate", createdAt: harness.clock.now() };
    await harness.deps.db.insert(tables.tenants).values(row);
    try {
      await harness.deps.db.insert(tables.tenants).values(row);
      return undefined;
    } catch (error) {
      return error;
    }
  };

  it("finds the PostgreSQL code even though the driver wraps the error", async () => {
    const error = await duplicateTenantInsert();
    expect(error).toBeDefined();
    // The shape the regression turned on: the thrown error carries no `code` of its own.
    expect((error as { code?: unknown }).code).toBeUndefined();
    expect(asPostgresError(error)?.code).toBe("23505");
  });

  it("carries the constraint name, which is what makes the response actionable", async () => {
    // The name is schema metadata we chose and says which rule was broken. PostgreSQL's `detail`
    // is deliberately not surfaced: it embeds the offending values, which can be customer data.
    const pg = asPostgresError(await duplicateTenantInsert());
    expect(pg?.constraint).toBe("tenants_pkey");
  });

  it("returns nothing for an error that is not a database error", () => {
    expect(asPostgresError(new Error("ordinary"))).toBeUndefined();
    expect(asPostgresError(undefined)).toBeUndefined();
  });

  it("does not spin on a cyclic cause", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(asPostgresError(a)).toBeUndefined();
  });
});
