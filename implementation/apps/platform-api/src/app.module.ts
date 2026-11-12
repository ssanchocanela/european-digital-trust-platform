import { type DynamicModule, Module } from "@nestjs/common";
import type { Dependencies } from "./composition.js";
import { ApiKeyGuard } from "./http/auth.js";
import {
  HealthController,
  PolicyController,
  PresentationController,
  TenantController,
  VerificationCapabilitiesController,
} from "./http/controllers.js";
import { PlatformErrorFilter } from "./http/error.filter.js";
import {
  IssuanceConfigurationController,
  IssuanceController,
} from "./http/issuance.controllers.js";
import {
  IdentityController,
  TenantListingController,
  TransactionListingController,
} from "./http/listing.controllers.js";
import { SandboxController } from "./http/sandbox.controllers.js";
import { SandboxCertificatesController } from "./http/sandbox-certificates.controller.js";
import { SandboxIssuerController } from "./http/sandbox-issuer.controller.js";
import { SandboxPublicController } from "./http/sandbox-public.controller.js";
import { SandboxVerifierController } from "./http/sandbox-verifier.controller.js";
import {
  EngineAttributesController,
  HostedFormController,
  HostedVerifierController,
} from "./http/wallet-initiated.controllers.js";
import {
  API_KEY_REPOSITORY,
  AUDIT_SERVICE,
  CLOCK_TOKEN,
  CONFIG_TOKEN,
  FEATURE_PID_DURING_ISSUANCE,
  HOSTED_FORM_RETURNS,
  ISSUANCE_REPOSITORY,
  ISSUANCE_SERVICE,
  ISSUER_PORT,
  ISSUER_PROVISIONING_PORT,
  LISTING_REPOSITORY,
  LOGGER_TOKEN,
  POLICY_SERVICE,
  PRESENTATION_SERVICE,
  REGISTERED_CONNECTORS,
  REGISTERED_EVALUATORS,
  REGISTRATION_SERVICE,
  SANDBOX_CERTIFICATES,
  SANDBOX_ISSUER,
  SANDBOX_PUBLIC,
  SANDBOX_SERVICE,
  SANDBOX_VERIFIER,
  VERIFIER_PORT,
  VERIFIER_PROVISIONING_PORT,
  WEBHOOK_ENDPOINT_REPOSITORY,
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
        VerificationCapabilitiesController,
        IdentityController,
        TenantListingController,
        TransactionListingController,
        HealthController,
        HostedFormController,
        HostedVerifierController,
        EngineAttributesController,
        SandboxController,
        SandboxPublicController,
        SandboxCertificatesController,
        SandboxVerifierController,
        SandboxIssuerController,
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
        { provide: LISTING_REPOSITORY, useValue: deps.repositories.listing },
        // Injected by the audit route. Absent until the listing controllers needed it, because until
        // then the audit service was only ever called from inside other services.
        { provide: AUDIT_SERVICE, useValue: deps.services.audit },
        {
          provide: WEBHOOK_ENDPOINT_REPOSITORY,
          useValue: deps.repositories.webhookEndpoints,
        },
        { provide: ISSUER_PORT, useValue: deps.issuer },
        { provide: ISSUER_PROVISIONING_PORT, useValue: deps.issuerProvisioning },
        { provide: ISSUANCE_SERVICE, useValue: deps.services.issuances },
        { provide: HOSTED_FORM_RETURNS, useValue: deps.hostedFormReturns },
        { provide: SANDBOX_SERVICE, useValue: deps.services.sandbox },
        { provide: SANDBOX_CERTIFICATES, useValue: deps.services.sandboxCertificates },
        { provide: SANDBOX_VERIFIER, useValue: deps.services.sandboxVerifier },
        { provide: SANDBOX_ISSUER, useValue: deps.services.sandboxIssuer },
        {
          provide: SANDBOX_PUBLIC,
          useValue:
            deps.services.sandboxPublications &&
            deps.services.sandboxRegister &&
            deps.sandboxTrustDomain
              ? {
                  publications: deps.services.sandboxPublications,
                  register: deps.services.sandboxRegister,
                  domain: deps.sandboxTrustDomain,
                }
              : undefined,
        },
        // Names only. Policy validation refuses an unknown evaluator or connector at publication,
        // so a typo fails while a reviewer is present rather than while a User is waiting.
        { provide: REGISTERED_EVALUATORS, useValue: [...deps.registry.evaluators.keys()] },
        {
          provide: REGISTERED_CONNECTORS,
          // Name and sample subjects, not just the name: the console needs to offer a
          // fixture's known subject references rather than hint at them in a placeholder,
          // which reads as a filled-in field and is not one.
          useValue: [...deps.registry.connectors.values()].map((c) => ({
            name: c.name,
            kind: c.kind,
            ...(c.sampleSubjectReferences
              ? { sampleSubjectReferences: c.sampleSubjectReferences }
              : {}),
          })),
        },
        {
          provide: FEATURE_PID_DURING_ISSUANCE,
          useValue: deps.config.FEATURE_PID_DURING_ISSUANCE,
        },
        ApiKeyGuard,
        PlatformErrorFilter,
      ],
    };
  }
}
