import type { EudiVerifierPort, EudiVerifierProvisioningPort } from "@edtp/eudi-verifier-port";
import { EngineClient, EudiploVerifierAdapter } from "@edtp/eudiplo-adapter";
import {
  ApiKeyRepository,
  AuditRepository,
  createDatabase,
  type Database,
  type DatabaseHandle,
  PolicyRepository,
  RegistrationRepository,
  TransactionRepository,
  WebhookDeliveryRepository,
} from "@edtp/persistence";
import { type Clock, systemClock } from "@edtp/shared";
import type { PlatformConfig } from "./config.js";
import { BackgroundJobs } from "./jobs/background.jobs.js";
import { Logger } from "./logging/logger.js";
import { AuditService } from "./modules/audit/audit.service.js";
import { PolicyService } from "./modules/policies/policy.service.js";
import { PresentationService } from "./modules/presentations/presentation.service.js";
import { RegistrationService } from "./modules/registration/registration.service.js";
import { WebhookService } from "./webhook/webhook.service.js";

/**
 * The composition root.
 *
 * Everything is assembled here, by hand, from plain constructors. That has a concrete
 * payoff: the integration suite builds the same graph against a real database and a fake
 * verifier port with no framework involved, so what the tests exercise is what runs.
 *
 * The only container-aware part is the HTTP layer, which is given the already-built
 * services as values.
 */
export interface Dependencies {
  readonly config: PlatformConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly db: Database;
  readonly repositories: {
    readonly registration: RegistrationRepository;
    readonly policies: PolicyRepository;
    readonly transactions: TransactionRepository;
    readonly audit: AuditRepository;
    readonly apiKeys: ApiKeyRepository;
    readonly deliveries: WebhookDeliveryRepository;
  };
  readonly verifier: EudiVerifierPort;
  readonly provisioning: EudiVerifierProvisioningPort;
  readonly services: {
    readonly audit: AuditService;
    readonly registration: RegistrationService;
    readonly policies: PolicyService;
    readonly presentations: PresentationService;
    readonly webhooks: WebhookService;
  };
  readonly jobs: BackgroundJobs;
}

export interface BuildOptions {
  readonly config: PlatformConfig;
  readonly db: Database;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** Substituted by the integration suite so the business layer runs with no engine. */
  readonly verifier?: EudiVerifierPort & Partial<EudiVerifierProvisioningPort>;
  readonly provisioning?: EudiVerifierProvisioningPort;
  readonly fetchImpl?: typeof fetch;
}

export const buildDependencies = (options: BuildOptions): Dependencies => {
  const { config, db } = options;
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? new Logger(config.LOG_LEVEL);

  const repositories = {
    registration: new RegistrationRepository(db),
    policies: new PolicyRepository(db),
    transactions: new TransactionRepository(db),
    audit: new AuditRepository(db),
    apiKeys: new ApiKeyRepository(db),
    deliveries: new WebhookDeliveryRepository(db),
  };

  // One adapter instance serves every engine tenant: it is stateless, and the client
  // resolves per-tenant credentials on demand (ADR 0002 Decision 3).
  const adapter = options.verifier
    ? undefined
    : new EudiploVerifierAdapter(
        new EngineClient({
          baseUrl: config.ENGINE_BASE_URL,
          clock,
          requestTimeoutMs: config.ENGINE_REQUEST_TIMEOUT_MS,
          credentials: {
            resolve: async (engineTenantRef: string) => {
              const credentials = config.engineCredentials.get(engineTenantRef);
              if (!credentials) {
                throw new Error(
                  `No engine credentials are configured for engine tenant '${engineTenantRef}'. ` +
                    "Add an entry to ENGINE_TENANT_CREDENTIALS.",
                );
              }
              return { engineTenantRef, ...credentials };
            },
          },
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        }),
      );

  const verifier: EudiVerifierPort = options.verifier ?? (adapter as EudiploVerifierAdapter);
  const provisioning: EudiVerifierProvisioningPort =
    options.provisioning ??
    (adapter as EudiploVerifierAdapter | undefined) ??
    (options.verifier as unknown as EudiVerifierProvisioningPort);

  const audit = new AuditService(repositories.audit, clock);
  const webhooks = new WebhookService(
    repositories.deliveries,
    repositories.transactions,
    repositories.registration,
    clock,
    logger,
    { maxAttempts: config.WEBHOOK_MAX_ATTEMPTS, timeoutMs: config.WEBHOOK_TIMEOUT_MS },
    options.fetchImpl ?? globalThis.fetch,
  );
  const registration = new RegistrationService(
    repositories.registration,
    repositories.apiKeys,
    provisioning,
    audit,
    clock,
  );
  const policies = new PolicyService(
    repositories.policies,
    repositories.registration,
    audit,
    clock,
  );
  const presentations = new PresentationService(
    repositories.registration,
    repositories.policies,
    repositories.transactions,
    verifier,
    audit,
    webhooks,
    clock,
    logger,
    config.PLATFORM_PUBLIC_URL,
  );

  const jobs = new BackgroundJobs(
    presentations,
    webhooks,
    repositories.transactions,
    clock,
    logger,
    config.JOB_INTERVAL_MS,
  );

  return {
    config,
    logger,
    clock,
    db,
    repositories,
    verifier,
    provisioning,
    services: { audit, registration, policies, presentations, webhooks },
    jobs,
  };
};

export const openDatabase = (config: PlatformConfig): DatabaseHandle =>
  createDatabase({ connectionString: config.DATABASE_URL, ssl: config.DATABASE_SSL });
