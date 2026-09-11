import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

/**
 * Boots one real PostgreSQL for the integration suite.
 *
 * A real database rather than a fake, because the suite exercises things only a real
 * PostgreSQL does: the checked-in migrations, unique indexes and foreign keys, `jsonb`
 * round-trips, the conditional-update concurrency guards, and `FOR UPDATE SKIP LOCKED`
 * in the delivery queue. An in-memory substitute would pass while leaving all of that
 * unverified.
 *
 * Embedded rather than containerised so the suite needs no Docker daemon and no external
 * service — it runs wherever Node runs.
 */
let instance: EmbeddedPostgres | undefined;
let dataDir: string | undefined;

const PORT = Number.parseInt(process.env.TEST_PG_PORT ?? "54399", 10);
const USER = "edtp_test";
const PASSWORD = "edtp_test";
const DATABASE = "edtp_test";

export const setup = async (): Promise<void> => {
  dataDir = mkdtempSync(join(tmpdir(), "edtp-pg-"));
  instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: false,
    onLog: () => {
      // PostgreSQL's own startup chatter is not useful here and would bury test output.
    },
  });
  await instance.initialise();
  await instance.start();
  await instance.createDatabase(DATABASE);

  process.env.TEST_DATABASE_URL = `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}`;
};

export const teardown = async (): Promise<void> => {
  if (instance) {
    await instance.stop();
    instance = undefined;
  }
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
};
