import { writeFileSync } from "node:fs";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import "reflect-metadata";
import { AppModule } from "./app.module.js";
import { buildDependencies, openDatabase } from "./composition.js";
import { loadConfig } from "./config.js";
import { Logger } from "./logging/logger.js";
import { openApiConfig } from "./openapi.js";

/**
 * Writes the business API's OpenAPI document to a file.
 *
 * ## Why a file, when the running API already serves one
 *
 * The served document at `/openapi-json` answers "what does this instance expose". The file answers
 * a different question: **what changed**. The document is generated from decorators, so a route that
 * gains a parameter, loses a guard, or starts returning a different shape changes it silently — and
 * a customer-facing contract that can move without anyone seeing the move is the thing this command
 * exists to stop.
 *
 * Checking the output in and diffing it in review is the point. `CLAUDE.md` §3.3 draws a hard line
 * between the business API and the EUDI protocol API; that line is only enforceable if the business
 * side is visible as a document rather than as a hundred decorators.
 *
 * ## Why it builds the whole dependency graph
 *
 * `AppModule` is a **dynamic** module: `withDependencies(deps)` is what registers the controllers,
 * so `createDocument` against the bare class produces a document with **zero paths** — which is
 * exactly what the first version of this file wrote, and a nought-path document is the sort of
 * output that gets committed once and believed.
 *
 * So it builds the same dependencies `main.ts` does and never calls `listen`: no port is opened and
 * no request is served. The database pool is created but never queried — `pg` connects lazily — so
 * **no database has to be running**, but the configuration still has to load, which means
 * `DATABASE_URL` and `ENGINE_BASE_URL` must be set even though neither is contacted. That is the
 * cost of generating from the real module graph, and it makes this a development command rather
 * than something a build runs unattended.
 *
 * Migrations are **not** run here, unlike at boot. Writing a document is a read of the code, and a
 * command that changes a database as a side effect of describing an API would be a bad surprise.
 *
 * The `package.json` script pointed at this file and the file did not exist. Written rather than the
 * script removed, because a generated contract nobody can diff is how the §3.3 boundary erodes.
 */

const OUTPUT = process.argv[2] ?? "docs/openapi.json";

const main = async (): Promise<void> => {
  const config = loadConfig();
  const logger = new Logger("error");
  const handle = openDatabase(config);
  const deps = buildDependencies({ config, db: handle.db, logger });

  // `error` only: a bootstrap failure must still print, for the reason recorded in `main.ts`, but
  // Nest's route-per-line startup output would bury the one path this command exists to report.
  const app = await NestFactory.create(AppModule.withDependencies(deps), { logger: ["error"] });
  try {
    const document = SwaggerModule.createDocument(app, openApiConfig(new DocumentBuilder()));
    // Two-space JSON with a trailing newline, so a diff shows the route that changed rather than one
    // reflowed line.
    const paths = Object.keys(document.paths ?? {}).length;
    // Refused rather than written. An empty document means the module graph did not register the
    // controllers, and it looks like a valid file — see the note above.
    if (paths === 0) {
      throw new Error(
        "the generated document has no paths, so the module graph registered no controllers. " +
          "Writing it would produce a file that looks valid and describes nothing.",
      );
    }
    writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    process.stdout.write(`Wrote ${OUTPUT} — ${paths} paths.\n`);
  } finally {
    await app.close();
    await handle.pool.end();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`api:openapi failed: ${(error as Error).message}\n`);
  process.exit(1);
});
