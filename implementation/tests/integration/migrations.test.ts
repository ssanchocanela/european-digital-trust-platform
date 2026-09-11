import { join } from "node:path";
import { loadMigrations, runMigrations } from "@edtp/persistence";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migrations up from an empty database.
 *
 * Required by the V0 plan, and run against a real PostgreSQL rather than a substitute,
 * because the point is that the checked-in SQL actually applies.
 *
 * A dedicated **database** rather than a schema: the generated SQL qualifies its foreign
 * keys as `"public"."…"`, so migrating into a non-`public` schema would fail for reasons
 * that have nothing to do with the migrations being correct. A fresh database also matches
 * how the migrations run in production.
 *
 * The checksum guard is the part worth testing hardest. Editing an applied migration is how
 * two databases silently diverge, and EUDIPLO shipped a release that had to add "the session
 * columns that no migration ever created" (ADR 0001). A loud failure is the whole feature.
 */
const MIGRATIONS_DIR = join(__dirname, "..", "..", "packages", "persistence", "migrations");

const dbName = `edtp_migrations_${Date.now()}`;
let adminPool: Pool;
let pool: Pool;

const baseUrl = (): string => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set.");
  return url;
};

beforeAll(async () => {
  adminPool = new Pool({ connectionString: baseUrl() });
  await adminPool.query(`CREATE DATABASE "${dbName}"`);

  const target = new URL(baseUrl());
  target.pathname = `/${dbName}`;
  pool = new Pool({ connectionString: target.toString() });
});

afterAll(async () => {
  if (pool) await pool.end();
  if (adminPool) {
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminPool.end();
  }
});

describe("migrations", () => {
  it("applies every checked-in migration to an empty database", async () => {
    const report = await runMigrations(pool, MIGRATIONS_DIR);
    const files = await loadMigrations(MIGRATIONS_DIR);

    expect(files.length).toBeGreaterThan(0);
    expect(report.applied).toEqual(files.map((f) => f.name));
    expect(report.skipped).toHaveLength(0);
  });

  it("creates exactly the expected tables, and no table for content", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const tables = rows.map((r) => r.table_name).sort();

    // Content has no table, on **either** side.
    //
    // Presentation content — VP tokens, credentials, disclosed claim values — and issuance content
    // — attribute values fetched from an authentic source — are both absent. That absence is the
    // guarantee in ADR 0004 and §7.5 of the V0 plan, so it is asserted rather than assumed: a
    // future migration adding a table for either would fail here.
    //
    // `issued_credentials` is metadata and a status reference; it holds no attribute values. The
    // column-level assertion below is what keeps that true as the table evolves.
    expect(tables).toEqual(
      [
        // Milestone 1 — verification
        "access_certificates",
        "api_keys",
        "audit_events",
        "intended_uses",
        "organisations",
        "presentation_policies",
        "presentation_policy_versions",
        "presentation_results",
        "presentation_transaction_transitions",
        "presentation_transactions",
        "registration_certificates",
        "relying_parties",
        "relying_party_instances",
        "relying_party_services",
        "schema_migrations", // created and owned by the migrator, not by the schema
        "tenants",
        "webhook_deliveries",
        // Shared infrastructure, generalised in Milestone 2 so issuance can reuse the queue
        "webhook_endpoints",
        "webhook_endpoint_secrets",
        // Milestone 2 — issuance
        "attestation_providers",
        "credential_types",
        "issuance_policies",
        "issuance_policy_versions",
        "issuance_transaction_transitions",
        "issuance_transactions",
        "issued_credentials",
        "trust_anchor_publications",
      ].sort(),
    );
  });

  it("keeps issued_credentials free of anything that could hold an attribute value", async () => {
    // The table is the one place an issuance leaves a durable trace, so its columns are pinned.
    // A migration adding `claims`, `attributes`, `payload` or similar would fail here — which is
    // the point: §7.5 says attribute values are never persisted, and a schema is where that
    // promise is either kept or quietly broken.
    const { rows } = await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
      ["issued_credentials"],
    );
    const columns = rows.map((r) => r.column_name).sort();

    expect(columns).toEqual(
      [
        "credential_type_id",
        "engine_session_ref",
        "expires_at",
        "id",
        "issuance_policy_id",
        "issuance_policy_version",
        "issuance_transaction_id",
        "issued_at",
        "status",
        "status_changed_at",
        "status_list_index",
        "status_list_uri",
        "tenant_id",
      ].sort(),
    );

    // And no column whose name suggests a value store, as a second line of defence for when
    // somebody adds a column and updates the list above without thinking about what it holds.
    //
    // Reference columns are exempt by shape: a `*_id` or `*_ref` names a row elsewhere, it does not
    // contain an attribute. Without that exemption `credential_type_id` trips the check, which is a
    // false positive that would teach the next person to delete the assertion rather than fix it.
    const contentWords = ["claim", "attribute", "payload", "disclosed", "sd_jwt", "value"];
    const suspicious = columns.filter(
      (c) =>
        !c.endsWith("_id") && !c.endsWith("_ref") && contentWords.some((w) => c.includes(w)),
    );
    expect(suspicious, "issued_credentials must hold no attribute values").toEqual([]);
  });

  it("is idempotent: a second run applies nothing", async () => {
    const report = await runMigrations(pool, MIGRATIONS_DIR);
    expect(report.applied).toHaveLength(0);
    expect(report.skipped.length).toBeGreaterThan(0);
  });

  it("enforces the one-registration-certificate-per-intended-use rule in the schema", async () => {
    // `EW-DM-44-014` (`RPRC_09`): one certificate per (intended use x Service). The unique
    // index is where that is enforced, so PostgreSQL itself must reject a second row.
    const { rows } = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1",
      ["registration_certificates"],
    );
    expect(rows.map((r) => r.indexname)).toContain("registration_certificates_use_key");
  });

  it("enforces one Relying Party Instance per Service and environment", async () => {
    // ADR 0002 Decision 3 maps one engine tenant to one Relying Party Instance, so a second
    // instance for the same Service and environment must be impossible.
    const { rows } = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1",
      ["relying_party_instances"],
    );
    expect(rows.map((r) => r.indexname)).toContain("relying_party_instances_service_env_key");
  });

  it("refuses to re-run a migration whose checksum changed", async () => {
    const files = await loadMigrations(MIGRATIONS_DIR);
    const first = files[0];
    expect(first).toBeDefined();

    await pool.query('UPDATE "schema_migrations" SET "checksum" = $1 WHERE "name" = $2', [
      "tampered-checksum",
      first?.name,
    ]);

    await expect(runMigrations(pool, MIGRATIONS_DIR)).rejects.toThrow(/checksum changed/i);

    await pool.query('UPDATE "schema_migrations" SET "checksum" = $1 WHERE "name" = $2', [
      first?.checksum,
      first?.name,
    ]);
  });

  it("records a SHA-256 checksum for every applied migration", async () => {
    const { rows } = await pool.query<{ name: string; checksum: string }>(
      'SELECT "name", "checksum" FROM "schema_migrations"',
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("rolls a failing migration back rather than leaving a partial schema", async () => {
    // Each migration runs in its own transaction. A later statement failing must leave none
    // of the earlier ones applied, or a retry would hit "already exists" forever.
    const { rows: before } = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public'",
    );

    const broken = join(__dirname, "..", "support", "broken-migrations");
    await expect(runMigrations(pool, broken)).rejects.toThrow(/failed/i);

    const { rows: after } = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public'",
    );
    expect(after[0]?.count).toBe(before[0]?.count);
  });
});
