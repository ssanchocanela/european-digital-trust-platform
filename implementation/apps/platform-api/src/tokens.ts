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

export const VERIFIER_PORT = Symbol("EudiVerifierPort");
export const VERIFIER_PROVISIONING_PORT = Symbol("EudiVerifierProvisioningPort");

export const AUDIT_SERVICE = Symbol("AuditService");
export const REGISTRATION_SERVICE = Symbol("RegistrationService");
export const POLICY_SERVICE = Symbol("PolicyService");
export const PRESENTATION_SERVICE = Symbol("PresentationService");
export const WEBHOOK_SERVICE = Symbol("WebhookService");
