import type { Config } from "drizzle-kit";

/**
 * Migration generation only. Migrations are generated from the schema, reviewed, and
 * checked in as plain SQL; they are applied at runtime by the checksum-verifying
 * migrator in `packages/persistence/src/migrate.ts`, never by a tool that can alter the
 * schema implicitly. There is no `synchronize` equivalent anywhere — ADR 0001.
 */
export default {
  schema: "./packages/persistence/src/schema.ts",
  out: "./packages/persistence/migrations",
  dialect: "postgresql",
  strict: true,
  verbose: false,
} satisfies Config;
