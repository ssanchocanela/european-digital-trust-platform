import type { AuthenticSourceConnector, EligibilityEvaluator } from "@edtp/domain";
import type { EudiIssuerPort, EudiIssuerProvisioningPort } from "@edtp/eudi-issuer-port";
import type { EudiVerifierPort, EudiVerifierProvisioningPort } from "@edtp/eudi-verifier-port";
import {
  EngineClient,
  EudiploIssuerAdapter,
  EudiploVerifierAdapter,
} from "@edtp/eudiplo-adapter";
import {
  ApiKeyRepository,
  AuditRepository,
  createDatabase,
  type Database,
  type DatabaseHandle,
  IssuanceRepository,
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
import {
  AlwaysEligibleEvaluator,
  FixtureAuthenticSourceConnector,
  MinimumAgeEligibilityEvaluator,
} from "./modules/issuances/fixture-connector.js";
import { IssuanceService } from "./modules/issuances/issuance.service.js";
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
    readonly issuance: IssuanceRepository;
  };
  readonly verifier: EudiVerifierPort;
  readonly provisioning: EudiVerifierProvisioningPort;
  readonly issuer: EudiIssuerPort;
  readonly issuerProvisioning: EudiIssuerProvisioningPort;
  /**
   * Named implementations registered at startup — not a rules engine, not an expression language.
   * Exposed so policy validation can refuse an unknown name at publication rather than at issuance.
   */
  readonly registry: {
    readonly connectors: ReadonlyMap<string, AuthenticSourceConnector>;
    readonly evaluators: ReadonlyMap<string, EligibilityEvaluator>;
  };
  readonly services: {
    readonly audit: AuditService;
    readonly registration: RegistrationService;
    readonly policies: PolicyService;
    readonly presentations: PresentationService;
    readonly webhooks: WebhookService;
    readonly issuances: IssuanceService;
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
  /** Substituted by the integration suite so issuance runs with no engine. */
  readonly issuer?: EudiIssuerPort & Partial<EudiIssuerProvisioningPort>;
  readonly issuerProvisioning?: EudiIssuerProvisioningPort;
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
    issuance: new IssuanceRepository(db),
  };

  // One adapter instance serves every engine tenant: it is stateless, and the client
  // resolves per-tenant credentials on demand (ADR 0002 Decision 3).
  const engineClient =
    options.verifier && options.issuer
      ? undefined
      : new EngineClient({
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
        });

  // One adapter instance per side serves every engine tenant: both are stateless, and the shared
  // client resolves per-tenant credentials on demand (ADR 0002 Decision 3).
  const adapter = options.verifier
    ? undefined
    : new EudiploVerifierAdapter(engineClient as EngineClient);
  const issuerAdapter = options.issuer
    ? undefined
    : new EudiploIssuerAdapter(engineClient as EngineClient);

  const verifier: EudiVerifierPort = options.verifier ?? (adapter as EudiploVerifierAdapter);
  const provisioning: EudiVerifierProvisioningPort =
    options.provisioning ??
    (adapter as EudiploVerifierAdapter | undefined) ??
    (options.verifier as unknown as EudiVerifierProvisioningPort);

  const issuer: EudiIssuerPort = options.issuer ?? (issuerAdapter as EudiploIssuerAdapter);
  const issuerProvisioning: EudiIssuerProvisioningPort =
    options.issuerProvisioning ??
    (issuerAdapter as EudiploIssuerAdapter | undefined) ??
    (options.issuer as unknown as EudiIssuerProvisioningPort);

  // Registered by name at startup, so a policy naming an unknown one is refused at publication.
  const connectors = new Map<string, AuthenticSourceConnector>();
  for (const c of [new FixtureAuthenticSourceConnector()]) connectors.set(c.name, c);
  const evaluators = new Map<string, EligibilityEvaluator>();
  for (const e of [new MinimumAgeEligibilityEvaluator(), new AlwaysEligibleEvaluator()]) {
    evaluators.set(e.name, e);
  }

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

  const issuances = new IssuanceService(
    repositories.issuance,
    issuer,
    issuerProvisioning,
    connectors,
    evaluators,
    audit,
    clock,
    logger,
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
    issuer,
    issuerProvisioning,
    registry: { connectors, evaluators },
    services: { audit, registration, policies, presentations, webhooks, issuances },
    jobs,
  };
};

export const openDatabase = (config: PlatformConfig): DatabaseHandle =>
  createDatabase({ connectionString: config.DATABASE_URL, ssl: config.DATABASE_SSL });
