import type { AuthenticSourceConnector, EligibilityEvaluator } from "@edtp/domain";
import type { EudiIssuerPort, EudiIssuerProvisioningPort } from "@edtp/eudi-issuer-port";
import type {
  EngineTenantPort,
  EudiVerifierPort,
  EudiVerifierProvisioningPort,
} from "@edtp/eudi-verifier-port";
import {
  ENGINE_ROOT_REF,
  EngineClient,
  EudiploIssuerAdapter,
  EudiploTenantAdapter,
  EudiploVerifierAdapter,
} from "@edtp/eudiplo-adapter";
import {
  ApiKeyRepository,
  AuditRepository,
  createDatabase,
  type Database,
  type DatabaseHandle,
  EngineCredentialRepository,
  IssuanceRepository,
  ListingRepository,
  PolicyRepository,
  RegistrationRepository,
  SandboxCertificateRepository,
  SandboxIssuerRepository,
  SandboxRepository,
  SandboxVerifierRepository,
  TransactionRepository,
  WebhookDeliveryRepository,
  WebhookEndpointRepository,
} from "@edtp/persistence";
import { asId, type Clock, systemClock } from "@edtp/shared";
import type { PlatformConfig } from "./config.js";
import { BackgroundJobs } from "./jobs/background.jobs.js";
import { Logger } from "./logging/logger.js";
import { AuditService } from "./modules/audit/audit.service.js";
import { EngineTenantService } from "./modules/engine-tenants/engine-tenant.service.js";
import {
  AlwaysEligibleEvaluator,
  FixtureAuthenticSourceConnector,
  MinimumAgeEligibilityEvaluator,
} from "./modules/issuances/fixture-connector.js";
import { HostedFormReturns } from "./modules/issuances/hosted-form-returns.js";
import { IssuanceService } from "./modules/issuances/issuance.service.js";
import { OperatorFormConnector } from "./modules/issuances/operator-form-connector.js";
import { VerifiedPresentationConnector } from "./modules/issuances/verified-presentation-connector.js";
import { WalletInitiatedClaims } from "./modules/issuances/wallet-initiated-claims.js";
import { PolicyService } from "./modules/policies/policy.service.js";
import { PresentationService } from "./modules/presentations/presentation.service.js";
import { RegistrationService } from "./modules/registration/registration.service.js";
import { SandboxCertificateService } from "./modules/sandbox/certificates.service.js";
import { SandboxIssuerService } from "./modules/sandbox/issuer.service.js";
import { SandboxMetadataService } from "./modules/sandbox/metadata.service.js";
import { SandboxPublicationService } from "./modules/sandbox/publication.service.js";
import { SandboxRegister } from "./modules/sandbox/register.js";
import { SandboxService } from "./modules/sandbox/sandbox.service.js";
import type { SandboxTrustDomain } from "./modules/sandbox/trust-domain.runtime.js";
import { sandboxUrls } from "./modules/sandbox/urls.js";
import { SandboxVerifierService } from "./modules/sandbox/verifier.service.js";
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
/**
 * The session retention asserted on a runtime engine tenant at creation. Each presentation sets its
 * own again when it starts; this keeps a fresh tenant minimal before its first use (CLAUDE.md §5).
 */
const ENGINE_TENANT_SESSION_TTL_SECONDS = 120;

/** The engine-held copy of the sandbox PID list, on every sandbox engine tenant. */
const SANDBOX_PID_TRUST_LIST_ID = "sbx-pid-providers";

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
    readonly webhookEndpoints: WebhookEndpointRepository;
    readonly listing: ListingRepository;
    readonly sandbox: SandboxRepository;
    readonly sandboxCertificates: SandboxCertificateRepository;
    readonly sandboxVerifiers: SandboxVerifierRepository;
    readonly sandboxIssuers: SandboxIssuerRepository;
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
    /** Present only when the sandbox is configured (`SANDBOX_PORTAL_SECRET`). */
    readonly sandbox?: SandboxService;
    /** Present only when the sandbox's PKI is configured (S3). */
    readonly sandboxCertificates?: SandboxCertificateService;
    readonly sandboxPublications?: SandboxPublicationService;
    readonly sandboxRegister?: SandboxRegister;
    /** Present only when the hosted verifier is configured (`SANDBOX_VERIFIER_DNS_NAME`, S4). */
    readonly sandboxVerifier?: SandboxVerifierService;
    /** Present when the sandbox's PKI is configured (S5). */
    readonly sandboxIssuer?: SandboxIssuerService;
    /** Signed metadata for sandbox issuers (S5b, ADR 0016). */
    readonly sandboxMetadata?: SandboxMetadataService;
    /** Present only when runtime engine tenants are configured (root client and sealing key). */
    readonly engineTenants?: EngineTenantService;
  };
  readonly jobs: BackgroundJobs;
  readonly sandboxTrustDomain?: SandboxTrustDomain;
  /** Where a browser goes after presenting, for presentations the hosted form started. */
  readonly hostedFormReturns: HostedFormReturns;
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
  /** The sandbox's trust domain, loaded from `SANDBOX_PKI_DIR` before composition (it reads files). */
  readonly sandboxTrustDomain?: SandboxTrustDomain;
  /** Substituted by the integration suite so runtime engine tenants need no engine. */
  readonly engineTenants?: EngineTenantPort;
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
    listing: new ListingRepository(db),
    sandbox: new SandboxRepository(db),
    sandboxCertificates: new SandboxCertificateRepository(db),
    sandboxVerifiers: new SandboxVerifierRepository(db),
    sandboxIssuers: new SandboxIssuerRepository(db),
    webhookEndpoints: new WebhookEndpointRepository(db),
  };

  // Every sandbox engine tenant holds the sandbox PID list under one id (S4), so a sandbox policy's
  // anchor source resolves to it there as the configured lists resolve on their own tenants.
  const sandboxPidListRef = config.SANDBOX_PUBLIC_BASE_URL
    ? sandboxUrls(config.SANDBOX_PUBLIC_BASE_URL).lote("PID")
    : undefined;
  const issuerTrustLists = {
    ...config.ENGINE_ISSUER_TRUST_LISTS,
    ...(sandboxPidListRef ? { [sandboxPidListRef]: SANDBOX_PID_TRUST_LIST_ID } : {}),
  };

  const engineCredentials = config.ENGINE_CREDENTIALS_KEY
    ? new EngineCredentialRepository(db, config.ENGINE_CREDENTIALS_KEY)
    : undefined;

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
            // The environment first, as before; then the root client, for tenant creation only;
            // then the tenants created at runtime (sandbox G-6).
            resolve: async (engineTenantRef: string) => {
              const configured = config.engineCredentials.get(engineTenantRef);
              if (configured) return { engineTenantRef, ...configured };
              if (
                engineTenantRef === ENGINE_ROOT_REF &&
                config.ENGINE_ROOT_CLIENT_ID &&
                config.ENGINE_ROOT_CLIENT_SECRET
              ) {
                return {
                  engineTenantRef,
                  clientId: config.ENGINE_ROOT_CLIENT_ID,
                  clientSecret: config.ENGINE_ROOT_CLIENT_SECRET,
                };
              }
              const stored =
                engineTenantRef !== ENGINE_ROOT_REF
                  ? await engineCredentials?.find(engineTenantRef)
                  : undefined;
              if (stored) return { engineTenantRef, ...stored };
              throw new Error(
                `No engine credentials are configured for engine tenant '${engineTenantRef}'. ` +
                  "Add an entry to ENGINE_TENANT_CREDENTIALS.",
              );
            },
          },
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });

  // One adapter instance per side serves every engine tenant: both are stateless, and the shared
  // client resolves per-tenant credentials on demand (ADR 0002 Decision 3).
  const adapter = options.verifier
    ? undefined
    : new EudiploVerifierAdapter(engineClient as EngineClient, {
        issuerTrustLists,
      });
  const issuerAdapter = options.issuer
    ? undefined
    : new EudiploIssuerAdapter(engineClient as EngineClient, {
        issuerTrustLists,
        ...(config.ENGINE_WALLET_PROVIDER_TRUST_LIST_ID
          ? { walletProviderTrustListId: config.ENGINE_WALLET_PROVIDER_TRUST_LIST_ID }
          : {}),
        issuerBranding: config.ENGINE_ISSUER_BRANDING,
        issuerDisplayNames: config.ENGINE_ISSUER_DISPLAY_NAMES,
        ...(config.ENGINE_ATTRIBUTE_PROVIDER_BASE_URL && config.ENGINE_ATTRIBUTE_PROVIDER_KEY
          ? {
              attributeProvider: {
                baseUrl: config.ENGINE_ATTRIBUTE_PROVIDER_BASE_URL,
                apiKey: config.ENGINE_ATTRIBUTE_PROVIDER_KEY,
              },
            }
          : {}),
      });

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
  for (const c of [
    new FixtureAuthenticSourceConnector(),
    // Issues from a presentation this platform has just verified. Tenant-scoped, and a FIXTURE:
    // the representation it attests comes from policy configuration, not from a register.
    new VerifiedPresentationConnector(repositories.transactions, clock),
    // The test PID issuer's form. The one source that takes attribute values from the caller, so
    // the service accepts it only under a TEST provider; FIXTURE for the same reason.
    new OperatorFormConnector(),
  ]) {
    connectors.set(c.name, c);
  }
  const evaluators = new Map<string, EligibilityEvaluator>();
  for (const e of [new MinimumAgeEligibilityEvaluator(), new AlwaysEligibleEvaluator()]) {
    evaluators.set(e.name, e);
  }

  const audit = new AuditService(repositories.audit, clock);
  const webhooks = new WebhookService(
    repositories.deliveries,
    repositories.transactions,
    repositories.registration,
    repositories.webhookEndpoints,
    clock,
    logger,
    { maxAttempts: config.WEBHOOK_MAX_ATTEMPTS, timeoutMs: config.WEBHOOK_TIMEOUT_MS },
    options.fetchImpl ?? globalThis.fetch,
  );
  const registration = new RegistrationService(
    repositories.registration,
    repositories.apiKeys,
    repositories.webhookEndpoints,
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
    config.PSEUDONYM_MASTER_KEY,
  );

  const issuances = new IssuanceService(
    repositories.issuance,
    repositories.webhookEndpoints,
    issuer,
    issuerProvisioning,
    connectors,
    evaluators,
    audit,
    webhooks,
    clock,
    logger,
    // Wallet-initiated issuance holds claims between the hosted form and the engine's call, in
    // memory only. Without an attribute provider configured there is no call to hold them for.
    config.ENGINE_ATTRIBUTE_PROVIDER_BASE_URL
      ? new WalletInitiatedClaims(() => clock.now())
      : undefined,
  );

  const hostedFormReturns = new HostedFormReturns(() => clock.now());
  const engineTenantPort =
    options.engineTenants ??
    (engineClient && config.ENGINE_ROOT_CLIENT_ID
      ? new EudiploTenantAdapter(engineClient)
      : undefined);
  const engineTenants =
    engineTenantPort && engineCredentials
      ? new EngineTenantService(
          engineTenantPort,
          engineCredentials,
          provisioning,
          clock,
          logger,
          ENGINE_TENANT_SESSION_TTL_SECONDS,
        )
      : undefined;
  const sandbox =
    config.SANDBOX_PORTAL_SECRET &&
    config.SANDBOX_OPERATOR_TENANT_ID &&
    config.SANDBOX_SIGN_IN_POLICY_ID &&
    config.SANDBOX_PORTAL_PUBLIC_URL
      ? new SandboxService(
          {
            operatorTenantId: asId<"TenantId">(config.SANDBOX_OPERATOR_TENANT_ID),
            signInPolicyId: config.SANDBOX_SIGN_IN_POLICY_ID,
            participantTrustSources: config.SANDBOX_PARTICIPANT_TRUST_SOURCES,
            portalPublicUrl: config.SANDBOX_PORTAL_PUBLIC_URL,
          },
          repositories.sandbox,
          repositories.policies,
          repositories.apiKeys,
          presentations,
          hostedFormReturns,
          audit,
          clock,
          logger,
        )
      : undefined;

  const pki =
    sandbox && options.sandboxTrustDomain && config.SANDBOX_PUBLIC_BASE_URL
      ? (() => {
          const urls = sandboxUrls(config.SANDBOX_PUBLIC_BASE_URL);
          const domain = options.sandboxTrustDomain;
          const publications = new SandboxPublicationService(
            repositories.sandboxCertificates,
            domain,
            urls,
            clock,
            logger,
          );
          const certificates = new SandboxCertificateService(
            sandbox,
            repositories.sandbox,
            repositories.sandboxCertificates,
            registration,
            domain,
            publications,
            urls,
            audit,
            clock,
          );
          const verifier =
            config.SANDBOX_VERIFIER_DNS_NAME && config.SANDBOX_PORTAL_PUBLIC_URL
              ? new SandboxVerifierService(
                  {
                    dnsName: config.SANDBOX_VERIFIER_DNS_NAME,
                    portalPublicUrl: config.SANDBOX_PORTAL_PUBLIC_URL,
                    pidListRef: urls.lote("PID"),
                    pidTrustListId: SANDBOX_PID_TRUST_LIST_ID,
                  },
                  sandbox,
                  certificates,
                  repositories.sandboxCertificates,
                  repositories.sandboxVerifiers,
                  repositories.registration,
                  registration,
                  policies,
                  presentations,
                  provisioning,
                  engineTenants,
                  domain,
                  hostedFormReturns,
                  audit,
                  clock,
                )
              : undefined;
          const issuerService = new SandboxIssuerService(
            {
              ...(config.ENGINE_WALLET_PROVIDER_TRUST_LIST_ID
                ? { walletProviderTrustListId: config.ENGINE_WALLET_PROVIDER_TRUST_LIST_ID }
                : {}),
              ...(config.SANDBOX_VERIFIER_DNS_NAME
                ? { metadataDnsName: config.SANDBOX_VERIFIER_DNS_NAME }
                : {}),
            },
            sandbox,
            repositories.sandbox,
            certificates,
            repositories.sandboxCertificates,
            repositories.sandboxIssuers,
            repositories.issuance,
            issuances,
            issuerProvisioning,
            provisioning,
            engineTenants,
            domain,
            audit,
            clock,
          );
          const metadata = new SandboxMetadataService(
            repositories.sandboxIssuers,
            repositories.sandboxCertificates,
            issuerProvisioning,
            domain,
            clock,
          );
          return {
            domain,
            publications,
            verifier,
            issuer: issuerService,
            metadata,
            register: new SandboxRegister(
              repositories.sandboxCertificates,
              domain,
              urls,
              clock,
            ),
            certificates,
          };
        })()
      : undefined;

  const jobs = new BackgroundJobs(
    presentations,
    webhooks,
    repositories.transactions,
    clock,
    logger,
    config.JOB_INTERVAL_MS,
    pki?.publications,
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
    services: {
      audit,
      registration,
      policies,
      presentations,
      webhooks,
      issuances,
      ...(sandbox ? { sandbox } : {}),
      ...(engineTenants ? { engineTenants } : {}),
      ...(pki
        ? {
            sandboxCertificates: pki.certificates,
            sandboxPublications: pki.publications,
            sandboxRegister: pki.register,
            ...(pki.verifier ? { sandboxVerifier: pki.verifier } : {}),
            sandboxIssuer: pki.issuer,
            sandboxMetadata: pki.metadata,
          }
        : {}),
    },
    jobs,
    hostedFormReturns,
    ...(pki ? { sandboxTrustDomain: pki.domain } : {}),
  };
};

export const openDatabase = (config: PlatformConfig): DatabaseHandle =>
  createDatabase({ connectionString: config.DATABASE_URL, ssl: config.DATABASE_SSL });
