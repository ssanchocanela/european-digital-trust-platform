import { randomBytes, randomUUID } from "node:crypto";

/**
 * Branded identifier types. They are structurally strings at runtime but are not
 * interchangeable at compile time, which stops a tenant id being passed where a
 * policy id is expected.
 */
declare const brand: unique symbol;
export type Branded<T, B extends string> = T & { readonly [brand]: B };

export type TenantId = Branded<string, "TenantId">;
export type OrganisationId = Branded<string, "OrganisationId">;
export type RelyingPartyId = Branded<string, "RelyingPartyId">;
export type RelyingPartyServiceId = Branded<string, "RelyingPartyServiceId">;
/** A tenant-scoped callback destination. Shared by verification and issuance. */
export type WebhookEndpointId = Branded<string, "WebhookEndpointId">;
export type IntendedUseId = Branded<string, "IntendedUseId">;
export type RelyingPartyInstanceId = Branded<string, "RelyingPartyInstanceId">;
export type RegistrationCertificateId = Branded<string, "RegistrationCertificateId">;
export type AccessCertificateId = Branded<string, "AccessCertificateId">;
export type PresentationPolicyId = Branded<string, "PresentationPolicyId">;
export type PresentationPolicyVersionId = Branded<string, "PresentationPolicyVersionId">;
export type PresentationId = Branded<string, "PresentationId">;
export type AuditEventId = Branded<string, "AuditEventId">;
export type WebhookDeliveryId = Branded<string, "WebhookDeliveryId">;
export type WebhookEventId = Branded<string, "WebhookEventId">;
export type CorrelationId = Branded<string, "CorrelationId">;

/** Opaque external identifier for an engine session. Never exposed to customers. */
export type EngineSessionRef = Branded<string, "EngineSessionRef">;

export const asId = <B extends string>(value: string): Branded<string, B> =>
  value as Branded<string, B>;

export const newUuid = (): string => randomUUID();

export const newTenantId = (): TenantId => asId<"TenantId">(randomUUID());
export const newOrganisationId = (): OrganisationId => asId<"OrganisationId">(randomUUID());
export const newRelyingPartyId = (): RelyingPartyId => asId<"RelyingPartyId">(randomUUID());
export const newRelyingPartyServiceId = (): RelyingPartyServiceId =>
  asId<"RelyingPartyServiceId">(randomUUID());
export const newWebhookEndpointId = (): WebhookEndpointId =>
  asId<"WebhookEndpointId">(randomUUID());
export const newIntendedUseId = (): IntendedUseId => asId<"IntendedUseId">(randomUUID());
export const newRelyingPartyInstanceId = (): RelyingPartyInstanceId =>
  asId<"RelyingPartyInstanceId">(randomUUID());
export const newRegistrationCertificateId = (): RegistrationCertificateId =>
  asId<"RegistrationCertificateId">(randomUUID());
export const newAccessCertificateId = (): AccessCertificateId =>
  asId<"AccessCertificateId">(randomUUID());
export const newPresentationPolicyId = (): PresentationPolicyId =>
  asId<"PresentationPolicyId">(randomUUID());
export const newPresentationPolicyVersionId = (): PresentationPolicyVersionId =>
  asId<"PresentationPolicyVersionId">(randomUUID());
export const newPresentationId = (): PresentationId => asId<"PresentationId">(randomUUID());
export const newAuditEventId = (): AuditEventId => asId<"AuditEventId">(randomUUID());
export const newWebhookDeliveryId = (): WebhookDeliveryId =>
  asId<"WebhookDeliveryId">(randomUUID());
export const newWebhookEventId = (): WebhookEventId => asId<"WebhookEventId">(randomUUID());
export const newCorrelationId = (): CorrelationId => asId<"CorrelationId">(randomUUID());

/** A URL-safe random token, used for development API keys. */
export const newOpaqueToken = (byteLength = 32): string =>
  randomBytes(byteLength).toString("base64url");
