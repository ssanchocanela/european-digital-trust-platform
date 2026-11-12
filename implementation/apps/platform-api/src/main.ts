import "reflect-metadata";
import { runMigrations } from "@edtp/persistence";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { buildDependencies, openDatabase } from "./composition.js";
import { loadConfig } from "./config.js";
import { createHttpApp } from "./http-app.js";
import { Logger } from "./logging/logger.js";
import { migrationsPath } from "./migrations-path.js";
import { SandboxTrustDomain } from "./modules/sandbox/trust-domain.runtime.js";
import { openApiConfig } from "./openapi.js";

/**
 * Entry point.
 *
 * Order matters: configuration is validated, then migrations are applied, then the HTTP
 * server starts. A configuration or migration failure must stop the process before it
 * accepts a request, rather than surfacing as a 500 on the first call.
 */
const bootstrap = async (): Promise<void> => {
  const config = loadConfig();
  const logger = new Logger(config.LOG_LEVEL);

  const handle = openDatabase(config);
  const report = await runMigrations(handle.pool, migrationsPath());
  logger.info("migrations applied", {
    applied: report.applied.length,
    skipped: report.skipped.length,
  });

  const sandboxTrustDomain =
    config.SANDBOX_PKI_DIR && config.SANDBOX_KEYSTORE_KEY
      ? await SandboxTrustDomain.load(config.SANDBOX_PKI_DIR, config.SANDBOX_KEYSTORE_KEY)
      : undefined;
  const deps = buildDependencies({
    config,
    db: handle.db,
    logger,
    ...(sandboxTrustDomain ? { sandboxTrustDomain } : {}),
  });
  // Publish at once, so a fresh sandbox serves its lists and CRLs from its first request.
  await deps.services.sandboxPublications?.publishAll();

  const app = await createHttpApp(deps);

  // Shared with `openapi-cli.ts`, which writes the same document to a file so the contract can be
  // diffed in review. One definition, or the served and the checked-in one drift apart.
  const openapi = openApiConfig(new DocumentBuilder());
  SwaggerModule.setup("openapi", app, SwaggerModule.createDocument(app, openapi));

  deps.jobs.start();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("shutting down", { signal });
    deps.jobs.stop();
    await app.close();
    await handle.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen(config.PORT, "0.0.0.0");
  logger.info("platform api listening", { port: config.PORT });
};

void bootstrap().catch((error: unknown) => {
  // Startup failures are written plainly: the logger's own configuration may be the thing
  // that failed, so this must not depend on it.
  process.stderr.write(
    `platform api failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
