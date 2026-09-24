import { type DynamicModule, Module } from "@nestjs/common";
import type { Dependencies } from "./composition.js";
import { ApiKeyGuard } from "./http/auth.js";
import {
  HealthController,
  PolicyController,
  PresentationController,
  TenantController,
} from "./http/controllers.js";
import { PlatformErrorFilter } from "./http/error.filter.js";
import {
  API_KEY_REPOSITORY,
  CLOCK_TOKEN,
  CONFIG_TOKEN,
  LOGGER_TOKEN,
  POLICY_SERVICE,
  PRESENTATION_SERVICE,
  REGISTRATION_SERVICE,
  VERIFIER_PORT,
  VERIFIER_PROVISIONING_PORT,
  WEBHOOK_SERVICE,
} from "./tokens.js";

/**
 * HTTP module.
 *
 * The dependency graph is built outside Nest (see `composition.ts`) and handed in as
 * values. Nest is used for routing, guards and the error filter only, which keeps the
 * business layer constructible without a container — the integration suite relies on that.
 */
@Module({})
export class AppModule {
  static withDependencies(deps: Dependencies): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        TenantController,
        PolicyController,
        PresentationController,
        HealthController,
      ],
      providers: [
        { provide: CONFIG_TOKEN, useValue: deps.config },
        { provide: LOGGER_TOKEN, useValue: deps.logger },
        { provide: CLOCK_TOKEN, useValue: deps.clock },
        { provide: API_KEY_REPOSITORY, useValue: deps.repositories.apiKeys },
        { provide: VERIFIER_PORT, useValue: deps.verifier },
        { provide: VERIFIER_PROVISIONING_PORT, useValue: deps.provisioning },
        { provide: REGISTRATION_SERVICE, useValue: deps.services.registration },
        { provide: POLICY_SERVICE, useValue: deps.services.policies },
        { provide: PRESENTATION_SERVICE, useValue: deps.services.presentations },
        { provide: WEBHOOK_SERVICE, useValue: deps.services.webhooks },
        ApiKeyGuard,
        PlatformErrorFilter,
      ],
    };
  }
}
