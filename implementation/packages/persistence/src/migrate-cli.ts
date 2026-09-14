import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";

/**
 * Applies the checked-in migrations, and says what it did.
 *
 * ## Why this exists when the API already migrates on boot
 *
 * `apps/platform-api` runs the same `runMigrations` before it accepts a request, so this is not the
 * only path and deliberately not a second implementation — it calls the same function against the
 * same directory.
 *
 * What it adds is **running them on purpose**. Migration `0006_engine_tenant_per_provider.sql`
 * changes data: it clears `engine_tenant_ref` on every Attestation Provider but the newest sharing
 * one. Applying that as a side effect of starting a process, with the report going to a log nobody
 * is watching, is the wrong way to find out it happened. Here it is the whole output.
 *
 * The `package.json` script pointed at this file and the file did not exist, so `pnpm db:migrate`
 * failed with a module-not-found error. Written rather than the script deleted, because the reason
 * to want it is the migration added the same week.
 *
 * Run through `pnpm db:migrate`, which points at the built output the way `pnpm registration` does.
 * Not `--experimental-strip-types`: this package is CommonJS and stripping leaves `import`
 * statements Node then refuses. That is what the script used to try.
 *
 * ## Connection
 *
 * `DATABASE_URL`, and nothing else. The API's own configuration loader validates a dozen unrelated
 * variables — webhook secrets, engine credentials, log levels — none of which a migration needs, and
 * requiring them here would make the command unusable in exactly the situation it is for: a database
 * that is being prepared before the rest of the environment exists.
 */

const migrationsDir = (): string => {
  // `__filename`, not `import.meta.url`: this package is CommonJS. The same resolution the API uses
  // in `migrations-path.ts`, for the same reason — it works from `dist/` or from source and stays
  // correct if the layout moves.
  const require = createRequire(__filename);
  const entry = require.resolve("@edtp/persistence");
  // <pkg>/dist/index.js -> <pkg>/migrations
  return join(dirname(dirname(entry)), "migrations");
};

const main = async (): Promise<void> => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    process.stderr.write(
      "db:migrate: set DATABASE_URL. It is a credential and must not be an argument,\n" +
        "because arguments are visible in the process list and land in shell history.\n",
    );
    process.exit(1);
  }

  const dir = migrationsDir();
  process.stdout.write(`Applying migrations from ${dir}\n`);

  const pool = new Pool({ connectionString });
  try {
    const report = await runMigrations(pool, dir);

    // Both lists, always. "0 applied" is the answer on a database that is already current, and it is
    // a different answer from "nothing ran because something went wrong".
    for (const name of report.skipped) {
      process.stdout.write(`  already applied  ${name}\n`);
    }
    for (const name of report.applied) {
      process.stdout.write(`  APPLIED          ${name}\n`);
    }
    process.stdout.write(
      `\n${report.applied.length} applied, ${report.skipped.length} already present.\n`,
    );

    if (report.applied.includes("0006_engine_tenant_per_provider")) {
      process.stdout.write(
        "\nNote: 0006 CHANGED DATA. It keeps the most recently created Attestation Provider on each\n" +
          "engine tenant and clears `engine_tenant_ref` on the rest, because for those the stored\n" +
          "reference was already false — only one provider's configuration is present in the engine.\n" +
          "Issuance from a cleared provider now fails with `attestation_provider_not_provisioned`.\n" +
          "Re-provision them onto their own engine tenants. See the migration for the full reasoning.\n",
      );
    }
  } finally {
    await pool.end();
  }
};

main().catch((error: unknown) => {
  // The message, not the stack: a migration failure is almost always a SQL error or a checksum
  // mismatch, and both say what is wrong in one line.
  process.stderr.write(`db:migrate failed: ${(error as Error).message}\n`);
  process.exit(1);
});
