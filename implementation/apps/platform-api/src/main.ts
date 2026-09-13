import "reflect-metadata";
import { runMigrations } from "@edtp/persistence";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module.js";
import { buildDependencies, openDatabase } from "./composition.js";
import { loadConfig } from "./config.js";
import { ApiKeyGuard } from "./http/auth.js";
import { PlatformErrorFilter } from "./http/error.filter.js";
import { Logger } from "./logging/logger.js";
import { migrationsPath } from "./migrations-path.js";
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

  const deps = buildDependencies({ config, db: handle.db, logger });

  const app = await NestFactory.create(AppModule.withDependencies(deps), {
    // Not `false`, which is what this was.
    //
    // Nest's startup output is noise — a line per route — but with the logger disabled entirely a
    // **bootstrap failure prints nothing at all**: the process ran its migrations and exited 1 in
    // silence, because `bootstrap().catch` never sees an error Nest handles itself. That cost a
    // debugging cycle over a missing provider. `error` and `warn` keep the noise out and the failures in.
    logger: ["error", "warn"],
    bodyParser: true,
  });
  // A modest body limit: every request in this API is small, and a large one is either a
  // mistake or an attempt to exhaust memory.
  app.useGlobalGuards(app.get(ApiKeyGuard));
  app.useGlobalFilters(new PlatformErrorFilter(logger));

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
