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
  IssuanceConfigurationController,
  IssuanceController,
} from "./http/issuance.controllers.js";
import {
  API_KEY_REPOSITORY,
  CLOCK_TOKEN,
  CONFIG_TOKEN,
  ISSUANCE_REPOSITORY,
  ISSUANCE_SERVICE,
  ISSUER_PORT,
  ISSUER_PROVISIONING_PORT,
  LOGGER_TOKEN,
  POLICY_SERVICE,
  PRESENTATION_SERVICE,
  REGISTERED_CONNECTORS,
  REGISTERED_EVALUATORS,
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
        IssuanceConfigurationController,
        IssuanceController,
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
        { provide: ISSUANCE_REPOSITORY, useValue: deps.repositories.issuance },
        { provide: ISSUER_PORT, useValue: deps.issuer },
        { provide: ISSUER_PROVISIONING_PORT, useValue: deps.issuerProvisioning },
        { provide: ISSUANCE_SERVICE, useValue: deps.services.issuances },
        // Names only. Policy validation refuses an unknown evaluator or connector at publication,
        // so a typo fails while a reviewer is present rather than while a User is waiting.
        { provide: REGISTERED_EVALUATORS, useValue: [...deps.registry.evaluators.keys()] },
        { provide: REGISTERED_CONNECTORS, useValue: [...deps.registry.connectors.keys()] },
        ApiKeyGuard,
        PlatformErrorFilter,
      ],
    };
  }
}
