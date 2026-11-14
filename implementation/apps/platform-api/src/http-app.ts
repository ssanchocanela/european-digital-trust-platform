import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import type { Dependencies } from "./composition.js";
import { ApiKeyGuard } from "./http/auth.js";
import { PlatformErrorFilter } from "./http/error.filter.js";
import { SandboxAccessGuard } from "./http/sandbox-access.guard.js";

/**
 * The HTTP application over a set of dependencies: the module, the global guard and the error
 * filter. One place, so `main.ts` and the tests that serve the real routes build the same thing.
 */
export async function createHttpApp(
  deps: Dependencies,
  options: { quiet?: boolean } = {},
): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.withDependencies(deps), {
    // Not `false` in production: with the logger disabled entirely a bootstrap failure prints
    // nothing at all. `error` and `warn` keep the noise out and the failures in.
    logger: options.quiet ? false : ["error", "warn"],
    bodyParser: true,
  });
  // Order matters: the API key guard sets the request context; the sandbox guard binds a portal
  // session to the Access identity (ADR 0018).
  app.useGlobalGuards(app.get(ApiKeyGuard), app.get(SandboxAccessGuard));
  app.useGlobalFilters(new PlatformErrorFilter(deps.logger));
  return app;
}
