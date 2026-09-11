import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";

/**
 * Migration runner.
 *
 * Applies the checked-in SQL files in lexical order, once each, inside a transaction,
 * recording a SHA-256 checksum per file. A file whose checksum changed after it was
 * applied is a hard failure: editing an applied migration means two databases can
 * silently diverge, which is how EUDIPLO ended up shipping a release that had to add
 * "the session columns that no migration ever created" (ADR 0001).
 *
 * There is no schema auto-synchronisation anywhere in the platform, and no code path
 * that can create a table outside a migration.
 */

export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

const checksum = (sql: string): string =>
  createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");

export const loadMigrations = async (dir: string): Promise<readonly MigrationFile[]> => {
  const entries = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const files: MigrationFile[] = [];
  for (const name of entries) {
    const sql = await readFile(join(dir, name), "utf8");
    files.push({ name, sql, checksum: checksum(sql) });
  }
  return files;
};

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS "schema_migrations" (
  "name" text PRIMARY KEY NOT NULL,
  "checksum" text NOT NULL,
  "applied_at" timestamp with time zone NOT NULL
)`;

/**
 * Advisory lock key for the migration run.
 *
 * Two application replicas starting at the same moment would otherwise both try to migrate.
 * `CREATE TABLE IF NOT EXISTS` is **not** concurrency-safe in PostgreSQL — two sessions
 * racing on it fail with a duplicate key on `pg_type` — and two replicas applying the same
 * migration would conflict anyway. A session-level advisory lock serialises the whole run,
 * so the second replica waits and then finds everything already applied.
 *
 * An arbitrary but fixed key, namespaced to this application.
 */
const MIGRATION_LOCK_KEY = 0x6564_7470; // "edtp"

export interface MigrationReport {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

export const runMigrations = async (
  pool: Pool,
  migrationsDir: string,
): Promise<MigrationReport> => {
  const files = await loadMigrations(migrationsDir);
  const applied: string[] = [];
  const skipped: string[] = [];

  const client = await pool.connect();
  try {
    // Serialise concurrent runs. Released explicitly below and implicitly if the connection
    // drops, so a crashed migrator cannot wedge the lock permanently.
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(LEDGER_DDL);
    const existing = await client.query<{ name: string; checksum: string }>(
      'SELECT "name", "checksum" FROM "schema_migrations"',
    );
    const byName = new Map(existing.rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const previous = byName.get(file.name);
      if (previous !== undefined) {
        if (previous !== file.checksum) {
          throw new Error(
            `Migration '${file.name}' has already been applied but its checksum changed. ` +
              "An applied migration must never be edited; add a new migration instead.",
          );
        }
        skipped.push(file.name);
        continue;
      }

      // Each migration is one transaction, so a failure leaves no partial schema.
      await client.query("BEGIN");
      try {
        // Drizzle separates statements with this marker; splitting on it keeps each
        // statement individually parseable by the driver.
        for (const statement of file.sql.split("--> statement-breakpoint")) {
          const trimmed = statement.trim();
          if (trimmed.length > 0) await client.query(trimmed);
        }
        await client.query(
          'INSERT INTO "schema_migrations" ("name", "checksum", "applied_at") VALUES ($1, $2, now())',
          [file.name, file.checksum],
        );
        await client.query("COMMIT");
        applied.push(file.name);
      } catch (cause) {
        await client.query("ROLLBACK");
        throw new Error(
          `Migration '${file.name}' failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
  } finally {
    // Best effort: if the connection already died the lock is gone with it.
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }

  return { applied, skipped };
};

/** The directory holding the checked-in migrations, resolved from this package. */
export const migrationsDirectory = (): string => join(__dirname, "..", "migrations");
