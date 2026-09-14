/**
 * Dependency-injection tokens.
 *
 * Every provider is injected by explicit token rather than by constructor type
 * reflection. That keeps the wiring independent of `emitDecoratorMetadata`, so the same
 * classes can be constructed directly in tests with no Nest container at all — which is
 * how the integration suite works.
 */
export const CONFIG_TOKEN = Symbol("PlatformConfig");
export const LOGGER_TOKEN = Symbol("Logger");
export const CLOCK_TOKEN = Symbol("Clock");
export const DATABASE_TOKEN = Symbol("Database");

export const REGISTRATION_REPOSITORY = Symbol("RegistrationRepository");
export const POLICY_REPOSITORY = Symbol("PolicyRepository");
export const TRANSACTION_REPOSITORY = Symbol("TransactionRepository");
export const AUDIT_REPOSITORY = Symbol("AuditRepository");
export const API_KEY_REPOSITORY = Symbol("ApiKeyRepository");
export const WEBHOOK_DELIVERY_REPOSITORY = Symbol("WebhookDeliveryRepository");
export const LISTING_REPOSITORY = Symbol("ListingRepository");

export const VERIFIER_PORT = Symbol("EudiVerifierPort");
export const VERIFIER_PROVISIONING_PORT = Symbol("EudiVerifierProvisioningPort");

export const AUDIT_SERVICE = Symbol("AuditService");
export const REGISTRATION_SERVICE = Symbol("RegistrationService");
export const POLICY_SERVICE = Symbol("PolicyService");
export const PRESENTATION_SERVICE = Symbol("PresentationService");
export const WEBHOOK_SERVICE = Symbol("WebhookService");

// --- Milestone 2: Issuance as a Service -------------------------------------------------
export const ISSUANCE_REPOSITORY = Symbol("IssuanceRepository");
export const ISSUER_PORT = Symbol("EudiIssuerPort");
export const ISSUER_PROVISIONING_PORT = Symbol("EudiIssuerProvisioningPort");
export const ISSUANCE_SERVICE = Symbol("IssuanceService");
/** Names only, for policy validation at publication time. */
export const REGISTERED_EVALUATORS = Symbol("RegisteredEvaluators");
export const REGISTERED_CONNECTORS = Symbol("RegisteredConnectors");
/** The shared callback destination repository, used by both verification and issuance. */
export const WEBHOOK_ENDPOINT_REPOSITORY = Symbol("WebhookEndpointRepository");
/** Feature flag: PID-during-issuance. Off until a wallet test passes. */
export const FEATURE_PID_DURING_ISSUANCE = Symbol("FeaturePidDuringIssuance");
