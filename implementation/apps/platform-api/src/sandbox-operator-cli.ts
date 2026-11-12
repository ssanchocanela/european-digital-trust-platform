import "reflect-metadata";
import { buildDependencies, openDatabase } from "./composition.js";
import { loadConfig } from "./config.js";
import { Logger } from "./logging/logger.js";
import { SandboxTrustDomain } from "./modules/sandbox/trust-domain.runtime.js";

/**
 * The sandbox operator's commands (specification J9), run where the platform runs, with its
 * environment. On the sandbox VM:
 *
 *   docker compose exec platform-api node apps/platform-api/dist/sandbox-operator-cli.js participants
 *   docker compose exec platform-api node apps/platform-api/dist/sandbox-operator-cli.js \
 *     suspend SB:ES-000001 --reason "<why, no personal data>"
 *
 * - `participants` lists every organisation: identifier, country, status, created.
 * - `suspend` suspends one: it creates nothing more, and every certificate it holds is revoked at once,
 *   which republishes the CRLs and status lists the running API serves. Final in v1.
 *
 * It prints identifiers and counts only, never a person's name or a PID value. Migrations are not run:
 * the API applied them at start.
 */
const USAGE = "usage: sandbox-operator-cli.js participants | suspend <SB:CC-n> --reason <text>";

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "participants" && command !== "suspend") {
    process.stderr.write(`${USAGE}\n`);
    return 64;
  }
  const config = loadConfig();
  if (!config.SANDBOX_PKI_DIR || !config.SANDBOX_KEYSTORE_KEY) {
    process.stderr.write("The sandbox's PKI is not configured here (SANDBOX_PKI_DIR).\n");
    return 78;
  }
  const handle = openDatabase(config);
  try {
    const sandboxTrustDomain = await SandboxTrustDomain.load(
      config.SANDBOX_PKI_DIR,
      config.SANDBOX_KEYSTORE_KEY,
    );
    const deps = buildDependencies({
      config,
      db: handle.db,
      logger: new Logger(config.LOG_LEVEL),
      sandboxTrustDomain,
    });

    if (command === "participants") {
      const organisations = await deps.repositories.sandbox.organisations();
      for (const o of organisations) {
        process.stdout.write(
          `${o.localIdentifier}\t${o.country}\t${o.status}\t${o.createdAt.toISOString()}\n`,
        );
      }
      process.stdout.write(`${organisations.length} organisation(s)\n`);
      return 0;
    }

    const [identifier, flag, ...reasonWords] = rest;
    const reason = reasonWords.join(" ").trim();
    if (
      !identifier ||
      !/^SB:[A-Z]{2}-\d{6,}$/.test(identifier) ||
      flag !== "--reason" ||
      !reason
    ) {
      process.stderr.write(`${USAGE}\n`);
      return 64;
    }
    const certificates = deps.services.sandboxCertificates;
    if (!certificates) {
      process.stderr.write("The sandbox's certificate service is not configured here.\n");
      return 78;
    }
    const result = await certificates.suspendOrganisation(identifier, reason);
    process.stdout.write(
      `${result.localIdentifier}: ${result.alreadySuspended ? "was already suspended" : "suspended"}; ` +
        `${result.revokedCertificates} certificate(s) revoked\n`,
    );
    return 0;
  } finally {
    await handle.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "failed"}\n`);
    process.exit(1);
  },
);
