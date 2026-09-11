import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Platform schema.
 *
 * The five data classes are kept separate **in storage**, not only in code:
 *
 * | Class                  | Tables                                                      |
 * |------------------------|-------------------------------------------------------------|
 * | Configuration          | tenants … presentation_policy_versions                      |
 * | Transaction metadata   | presentation_transactions, presentation_transaction_transitions |
 * | Derived result         | presentation_results                                        |
 * | Audit evidence         | audit_events                                                |
 * | Delivery               | webhook_deliveries                                          |
 * | **Content**            | **no table**                                                |
 *
 * Content — VP tokens, credentials, SD-JWTs, mdocs, raw PID, disclosed claim values —
 * has no table at all. That is the strongest available form of the guarantee in
 * ADR 0004: there is nowhere for it to be written, so the property does not depend on
 * anyone remembering it.
 *
 * Every tenant-scoped table carries `tenant_id`, and every repository query filters on
 * it. Cross-tenant rejection is asserted by tests rather than assumed.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// --- configuration --------------------------------------------------------------

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: ts("created_at").notNull(),
});

/**
 * Development authentication: one API key per tenant.
 *
 * Only a SHA-256 hash is stored, with a short non-secret prefix for lookup, so a
 * database dump does not yield usable credentials. This is a documented development
 * mechanism — see `docs/security-limitations.md`.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    label: text("label").notNull(),
    createdAt: ts("created_at").notNull(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    uniqueIndex("api_keys_prefix_key").on(t.keyPrefix),
    index("api_keys_tenant_idx").on(t.tenantId),
  ],
);

export const organisations = pgTable(
  "organisations",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    legalName: text("legal_name").notNull(),
    /** TS5 identifiers; `http://data.europa.eu/eudi/id/EUID` is the default scheme. */
    officialIdentifiers: jsonb("official_identifiers").notNull(),
    memberState: text("member_state").notNull(),
    isPublicSectorBody: boolean("is_public_sector_body").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("organisations_tenant_idx").on(t.tenantId)],
);

export const relyingParties = pgTable(
  "relying_parties",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "restrict" }),
    /** Registrar-assigned and EU-wide unique — `AS-MS-27-043` (`Reg_32`). */
    registrarAssignedIdentifier: text("registrar_assigned_identifier").notNull(),
    registrar: text("registrar").notNull(),
    registryUri: text("registry_uri"),
    tradeName: text("trade_name"),
    trustEnvironment: text("trust_environment").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    // `EW-DM-44-013` (`RPRC_08`): the identifier is identical across an entity's
    // certificates, so it must be unique per environment within the platform.
    uniqueIndex("relying_parties_identifier_key").on(
      t.registrarAssignedIdentifier,
      t.trustEnvironment,
    ),
    index("relying_parties_tenant_idx").on(t.tenantId),
  ],
);

/**
 * A tenant-scoped callback destination: signing secret and URL allow-list.
 *
 * Milestone 1 kept both on `relying_party_services`, which could not serve issuance — an issuance has
 * no Relying Party Service, so the delivery queue could not resolve a secret for it. Signing and SSRF
 * protection are shared infrastructure, so they live here and both sides reference them.
 *
 * The secret is in its own table, not a column here, so a `SELECT *` on the endpoint cannot return
 * it. It is read only by the delivery path, only to sign.
 */
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** HTTPS only, matched exactly. An arbitrary per-request URL is refused. */
    callbackUrlAllowList: jsonb("callback_url_allow_list").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("webhook_endpoints_tenant_idx").on(t.tenantId)],
);

export const webhookEndpointSecrets = pgTable("webhook_endpoint_secrets", {
  endpointId: uuid("endpoint_id")
    .primaryKey()
    .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
  secret: text("secret").notNull(),
});

export const relyingPartyServices = pgTable(
  "relying_party_services",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    relyingPartyId: uuid("relying_party_id")
      .notNull()
      .references(() => relyingParties.id, { onDelete: "restrict" }),
    /** RP-chosen, unique within the Relying Party — ARF §3.11.2, `Reg_33`. */
    serviceIdentifier: text("service_identifier").notNull(),
    serviceTradeName: text("service_trade_name").notNull(),
    description: jsonb("description").notNull(),
    /** HTTPS allow-list for callbacks. An unlisted URL is refused (SSRF protection). */
    callbackUrlAllowList: jsonb("callback_url_allow_list").notNull(),
    /** Per-service HMAC secret for outbound webhook signing. */
    /**
     * The callback destination. Nullable only so the migration can backfill it; every row created
     * after 0002 has one.
     */
    webhookEndpointId: uuid("webhook_endpoint_id").references(() => webhookEndpoints.id, {
      onDelete: "restrict",
    }),
    /**
     * Superseded by `webhook_endpoint_id`. Retained, not dropped, so migration 0002 is reversible and
     * so an operator can confirm the backfill before the column goes. Nothing reads it.
     */
    webhookSecret: text("webhook_secret"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("relying_party_services_identifier_key").on(
      t.relyingPartyId,
      t.serviceIdentifier,
    ),
    index("relying_party_services_tenant_idx").on(t.tenantId),
  ],
);

export const intendedUses = pgTable(
  "intended_uses",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    relyingPartyServiceId: uuid("relying_party_service_id")
      .notNull()
      .references(() => relyingPartyServices.id, { onDelete: "restrict" }),
    /** Registrar-provided, never platform-minted — TS5 `intendedUseIdentifier`. */
    intendedUseIdentifier: text("intended_use_identifier").notNull(),
    /** Localised; displayed to the User by the Wallet — `AS-WP-06-015` (`RPA_10`). */
    purpose: jsonb("purpose").notNull(),
    privacyPolicyUris: jsonb("privacy_policy_uris").notNull(),
    /** Registered attributes per credential, as OpenID4VP claim paths. */
    registeredCredentials: jsonb("registered_credentials").notNull(),
    validFrom: ts("valid_from").notNull(),
    revokedAt: ts("revoked_at"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("intended_uses_identifier_key").on(
      t.relyingPartyServiceId,
      t.intendedUseIdentifier,
    ),
    index("intended_uses_tenant_idx").on(t.tenantId),
  ],
);

/**
 * `EW-DM-44-014` (`RPRC_09`): one registration certificate per combination of intended
 * use and Relying Party Service. The unique index enforces exactly that.
 *
 * `jwt` is nullable because V0 has no reachable provider of registration certificates
 * (blocker B3). A row without a JWT records that the certificate is missing; it never
 * stands in for one.
 */
export const registrationCertificates = pgTable(
  "registration_certificates",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    relyingPartyServiceId: uuid("relying_party_service_id")
      .notNull()
      .references(() => relyingPartyServices.id, { onDelete: "restrict" }),
    intendedUseId: uuid("intended_use_id")
      .notNull()
      .references(() => intendedUses.id, { onDelete: "restrict" }),
    jwt: text("jwt"),
    provider: text("provider"),
    notBefore: ts("not_before"),
    notAfter: ts("not_after"),
    trustEnvironment: text("trust_environment").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("registration_certificates_use_key").on(
      t.relyingPartyServiceId,
      t.intendedUseId,
    ),
    index("registration_certificates_tenant_idx").on(t.tenantId),
  ],
);

/**
 * The access certificate, bound to the Relying Party identifier, the Service identifier
 * and a key held in the engine key store.
 *
 * **No private key material is modelled**, only `key_binding_ref` — an opaque reference
 * to the engine key chain. There is therefore no platform-side key to protect, dump or
 * log.
 */
export const accessCertificates = pgTable(
  "access_certificates",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    relyingPartyId: uuid("relying_party_id")
      .notNull()
      .references(() => relyingParties.id, { onDelete: "restrict" }),
    relyingPartyServiceId: uuid("relying_party_service_id")
      .notNull()
      .references(() => relyingPartyServices.id, { onDelete: "restrict" }),
    keyBindingRef: text("key_binding_ref").notNull(),
    subject: text("subject"),
    issuer: text("issuer"),
    notBefore: ts("not_before"),
    notAfter: ts("not_after"),
    trustEnvironment: text("trust_environment").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("access_certificates_service_idx").on(t.relyingPartyServiceId)],
);

/**
 * One row per platform-hosted Relying Party Instance, mapping 1:1 to an engine tenant.
 *
 * ADR 0002 Decision 3: the engine scopes key material, certificates and registrar
 * configuration per tenant, while ARF scopes those to a Relying Party Service — so the
 * mapping is per Service and environment, not per platform Tenant.
 */
export const relyingPartyInstances = pgTable(
  "relying_party_instances",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    relyingPartyServiceId: uuid("relying_party_service_id")
      .notNull()
      .references(() => relyingPartyServices.id, { onDelete: "restrict" }),
    engineTenantRef: text("engine_tenant_ref").notNull(),
    trustEnvironment: text("trust_environment").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("relying_party_instances_service_env_key").on(
      t.relyingPartyServiceId,
      t.trustEnvironment,
    ),
  ],
);

export const presentationPolicies = pgTable(
  "presentation_policies",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    relyingPartyServiceId: uuid("relying_party_service_id")
      .notNull()
      .references(() => relyingPartyServices.id, { onDelete: "restrict" }),
    intendedUseId: uuid("intended_use_id")
      .notNull()
      .references(() => intendedUses.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    status: text("status").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("presentation_policies_tenant_idx").on(t.tenantId)],
);

/**
 * A published version is immutable. Nothing in the repository layer updates a row whose
 * status is not `DRAFT`, and every transaction references `(policy_id, version)` so a
 * later version cannot rewrite history.
 */
export const presentationPolicyVersions = pgTable(
  "presentation_policy_versions",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => presentationPolicies.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    purpose: jsonb("purpose").notNull(),
    credentialRequirements: jsonb("credential_requirements").notNull(),
    requestedClaims: jsonb("requested_claims").notNull(),
    trustPolicy: jsonb("trust_policy").notNull(),
    resultPolicy: jsonb("result_policy").notNull(),
    retentionPolicy: jsonb("retention_policy").notNull(),
    status: text("status").notNull(),
    createdAt: ts("created_at").notNull(),
    publishedAt: ts("published_at"),
    retiredAt: ts("retired_at"),
  },
  (t) => [
    uniqueIndex("presentation_policy_versions_key").on(t.policyId, t.version),
    index("presentation_policy_versions_tenant_idx").on(t.tenantId),
  ],
);

// --- transaction metadata -------------------------------------------------------

/**
 * Transaction metadata. Holds **no** presentation content: no VP token, no credential,
 * no disclosed claim value.
 *
 * `engine_session_ref` and `engine_tenant_ref` are internal correlation metadata. They
 * are never exposed in the business API, and the pair is what lets the stateless adapter
 * address the session after a restart.
 */
export const presentationTransactions = pgTable(
  "presentation_transactions",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    relyingPartyServiceId: uuid("relying_party_service_id")
      .notNull()
      .references(() => relyingPartyServices.id, { onDelete: "restrict" }),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => presentationPolicies.id, { onDelete: "restrict" }),
    policyVersion: integer("policy_version").notNull(),
    businessReference: text("business_reference").notNull(),
    state: text("state").notNull(),
    interactionType: text("interaction_type").notNull(),
    deliveryStatus: text("delivery_status").notNull(),
    callbackUrl: text("callback_url"),
    engineSessionRef: text("engine_session_ref"),
    engineTenantRef: text("engine_tenant_ref"),
    failureCode: text("failure_code"),
    /**
     * Recorded when a request was sent without a registration certificate, so the
     * omission required by `EW-DM-44-023` (`RPRC_19`) is visible in the evidence rather
     * than invisible.
     */
    sentWithoutRegistrationCertificate: boolean("sent_without_registration_certificate")
      .notNull()
      .default(false),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
    closedAt: ts("closed_at"),
  },
  (t) => [
    index("presentation_transactions_tenant_idx").on(t.tenantId),
    index("presentation_transactions_state_idx").on(t.state, t.expiresAt),
    uniqueIndex("presentation_transactions_engine_session_key").on(t.engineSessionRef),
    index("presentation_transactions_business_ref_idx").on(t.tenantId, t.businessReference),
  ],
);

/** Append-only state-change log, used as audit evidence. */
export const presentationTransactionTransitions = pgTable(
  "presentation_transaction_transitions",
  {
    presentationId: uuid("presentation_id")
      .notNull()
      .references(() => presentationTransactions.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    fromState: text("from_state").notNull(),
    toState: text("to_state").notNull(),
    reason: text("reason").notNull(),
    at: ts("at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.presentationId, t.sequence] })],
);

// --- derived result -------------------------------------------------------------

/**
 * The normalised, minimised result.
 *
 * A different data class from transaction metadata, with a different lifecycle, so it is
 * a different table: `purge_after` lets the retention job delete results while the
 * metadata and audit trail survive.
 *
 * `claims` holds only what the result policy emitted — allowed verified attributes or
 * derived values. The `OIA_16` unique elements are stripped before this row is written
 * and again before the value leaves the API.
 */
export const presentationResults = pgTable(
  "presentation_results",
  {
    presentationId: uuid("presentation_id")
      .primaryKey()
      .references(() => presentationTransactions.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    claims: jsonb("claims").notNull(),
    createdAt: ts("created_at").notNull(),
    purgeAfter: ts("purge_after").notNull(),
  },
  (t) => [index("presentation_results_purge_idx").on(t.purgeAfter)],
);

// --- audit evidence -------------------------------------------------------------

/**
 * Purpose-limited audit record: actor, action, policy and configuration versions,
 * outcome, correlation id and evidence **references**.
 *
 * `detail` is redacted before it is written, by the same deny-list the logger uses, so
 * an audit row cannot become a back door for content.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    at: ts("at").notNull(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id"),
    policyId: uuid("policy_id"),
    policyVersion: integer("policy_version"),
    outcome: text("outcome"),
    correlationId: text("correlation_id"),
    detail: jsonb("detail"),
  },
  (t) => [
    index("audit_events_tenant_at_idx").on(t.tenantId, t.at),
    index("audit_events_subject_idx").on(t.subjectType, t.subjectId),
  ],
);

// --- delivery -------------------------------------------------------------------

/**
 * Outbound webhook delivery queue.
 *
 * A database-backed queue rather than a broker, per ADR 0003: exponential backoff with a
 * bounded attempt count and a per-event id for idempotency is all the V0 requirement
 * asks for, and a table provides it.
 *
 * `payload` is the normalised result only — never presentation content.
 */
/**
 * The delivery queue, now subject-agnostic.
 *
 * Milestone 1 keyed each row to a presentation and resolved the signing secret by walking
 * presentation -> Relying Party Service. That walk is what could not serve issuance. A row now names
 * its `webhook_endpoint_id` directly, so the secret is one lookup away whatever the subject is, and
 * `subject_type` + `subject_id` identify what the event is about.
 *
 * `presentation_id` is retained and nullable for the same reason as `webhook_secret` above: migration
 * 0002 backfills from it, and keeping it makes the change reversible.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /**
     * The callback destination, and therefore the signing secret. One lookup, whatever the subject.
     *
     * Nullable only so migration 0002 can backfill; every row enqueued after it has one, and the
     * delivery path refuses to send without it rather than signing with something else.
     */
    webhookEndpointId: uuid("webhook_endpoint_id").references(() => webhookEndpoints.id, {
      onDelete: "restrict",
    }),
    /** `presentation` or `issuance`. What the event is about. */
    subjectType: text("subject_type"),
    subjectId: uuid("subject_id"),
    /** Superseded by `subject_type` + `subject_id`. Retained so 0002 is reversible. */
    presentationId: uuid("presentation_id").references(() => presentationTransactions.id, {
      onDelete: "cascade",
    }),
    /** Stable across retries, so a receiver can deduplicate. */
    eventId: uuid("event_id").notNull(),
    url: text("url").notNull(),
    payload: jsonb("payload").notNull(),
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull(),
    status: text("status").notNull(),
    nextAttemptAt: ts("next_attempt_at").notNull(),
    lastError: text("last_error"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("webhook_deliveries_event_key").on(t.eventId),
    index("webhook_deliveries_due_idx").on(t.status, t.nextAttemptAt),
    index("webhook_deliveries_subject_idx").on(t.subjectType, t.subjectId),
  ],
);

/**
 * The applied-migration ledger is **deliberately not declared here.**
 *
 * `migrate.ts` creates and owns it. Declaring it in this schema would make the generator
 * emit DDL for it inside migration 0000, which the migrator has already created by the time
 * it runs that file — so the very first migration would fail on a fresh database. Ownership
 * belongs to exactly one of the two.
 */

// ---------------------------------------------------------------------------------------
// Milestone 2 — Issuance as a Service
//
// The same five data classes hold. **Content still has no table:** attribute values fetched
// from an authentic source exist between the connector call and the engine call and are never
// written here. `issued_credentials` is metadata and a status reference, nothing more.
// ---------------------------------------------------------------------------------------

/**
 * An Organisation's registration as an Attestation Provider, and its engine tenant.
 *
 * One engine tenant per provider and environment, for the same reason ADR 0002 Decision 3 gives
 * on the verification side: the engine scopes key material and registrar configuration to its
 * tenant, while ARF scopes them to the provider.
 */
export const attestationProviders = pgTable(
  "attestation_providers",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "restrict" }),
    registrarAssignedIdentifier: text("registrar_assigned_identifier").notNull(),
    registrar: text("registrar"),
    /** Opaque reference to the engine key chain holding the attestation-signing key. */
    signingKeyBindingRef: text("signing_key_binding_ref"),
    /** The registration certificate published in the Credential Issuer metadata (gate a). */
    registrationCertificateJwt: text("registration_certificate_jwt"),
    registrationCertificateNotAfter: ts("registration_certificate_not_after"),
    engineTenantRef: text("engine_tenant_ref"),
    /** The same shared endpoint type the verification side uses. */
    webhookEndpointId: uuid("webhook_endpoint_id").references(() => webhookEndpoints.id, {
      onDelete: "restrict",
    }),
    trustEnvironment: text("trust_environment").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("attestation_providers_identifier_key").on(
      t.registrarAssignedIdentifier,
      t.trustEnvironment,
    ),
    index("attestation_providers_tenant_idx").on(t.tenantId),
  ],
);

/**
 * A platform-owned credential type.
 *
 * `rulebook_*` is trust configuration, not documentation: ARF §6.3.2.4 makes the Rulebook the
 * source of trust anchors for verifying a non-qualified EAA's signature, so a type whose Rulebook
 * is unknown cannot be issued.
 */
export const credentialTypes = pgTable(
  "credential_types",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    attestationProviderId: uuid("attestation_provider_id")
      .notNull()
      .references(() => attestationProviders.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    format: text("format").notNull(),
    vct: text("vct"),
    doctype: text("doctype"),
    rulebookIdentifier: text("rulebook_identifier").notNull(),
    rulebookVersion: text("rulebook_version").notNull(),
    rulebookPublicationUri: text("rulebook_publication_uri"),
    rulebookAnchorSource: text("rulebook_anchor_source").notNull(),
    /** Claim definitions: paths, display text, value types. Never values. */
    claims: jsonb("claims").notNull(),
    display: jsonb("display").notNull(),
    validitySeconds: integer("validity_seconds").notNull(),
    statusMechanism: text("status_mechanism").notNull(),
    requiresKeyBinding: boolean("requires_key_binding").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    index("credential_types_tenant_idx").on(t.tenantId),
    index("credential_types_provider_idx").on(t.attestationProviderId),
  ],
);

export const issuancePolicies = pgTable(
  "issuance_policies",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    credentialTypeId: uuid("credential_type_id")
      .notNull()
      .references(() => credentialTypes.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    status: text("status").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("issuance_policies_tenant_idx").on(t.tenantId)],
);

/** Immutable once published, like its verification-side counterpart. */
export const issuancePolicyVersions = pgTable(
  "issuance_policy_versions",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => issuancePolicies.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    credentialTypeId: uuid("credential_type_id")
      .notNull()
      .references(() => credentialTypes.id, { onDelete: "restrict" }),
    purpose: jsonb("purpose").notNull(),
    eligibilityRule: jsonb("eligibility_rule").notNull(),
    authenticSource: jsonb("authentic_source").notNull(),
    holderBinding: text("holder_binding").notNull(),
    flow: text("flow").notNull(),
    credentialValiditySeconds: integer("credential_validity_seconds").notNull(),
    statusPolicy: jsonb("status_policy").notNull(),
    retentionPolicy: jsonb("retention_policy").notNull(),
    /** The §7.3 stretch goal: require a PID presentation first, reusing a verification policy. */
    eligibilityPresentationPolicyId: uuid("eligibility_presentation_policy_id").references(
      () => presentationPolicies.id,
      { onDelete: "restrict" },
    ),
    createdAt: ts("created_at").notNull(),
    publishedAt: ts("published_at"),
  },
  (t) => [
    uniqueIndex("issuance_policy_versions_key").on(t.policyId, t.version),
    index("issuance_policy_versions_tenant_idx").on(t.tenantId),
  ],
);

/**
 * Issuance transaction metadata.
 *
 * `subject_reference` is a **lookup key** for the authentic source, not attribute values — the
 * business client says who to ask about, and the platform asks. `authentic_source_kind` records
 * whether the values came from a real source or a fixture, so an attestation issued from test data
 * can never be mistaken for one issued from a real source.
 */
export const issuanceTransactions = pgTable(
  "issuance_transactions",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => issuancePolicies.id, { onDelete: "restrict" }),
    policyVersion: integer("policy_version").notNull(),
    credentialTypeId: uuid("credential_type_id")
      .notNull()
      .references(() => credentialTypes.id, { onDelete: "restrict" }),
    state: text("state").notNull(),
    businessReference: text("business_reference"),
    subjectReference: text("subject_reference").notNull(),
    authenticSourceKind: text("authentic_source_kind"),
    eligibilityReason: text("eligibility_reason"),
    engineSessionRef: text("engine_session_ref"),
    engineTenantRef: text("engine_tenant_ref"),
    sentWithoutRegistrationCertificate: boolean("sent_without_registration_certificate"),
    callbackUrl: text("callback_url"),
    deliveryStatus: text("delivery_status").notNull(),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    providerSideFailure: boolean("provider_side_failure"),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    index("issuance_transactions_tenant_idx").on(t.tenantId),
    index("issuance_transactions_state_idx").on(t.state),
    index("issuance_transactions_expiry_idx").on(t.expiresAt),
  ],
);

export const issuanceTransactionTransitions = pgTable(
  "issuance_transaction_transitions",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    issuanceTransactionId: uuid("issuance_transaction_id")
      .notNull()
      .references(() => issuanceTransactions.id, { onDelete: "cascade" }),
    fromState: text("from_state").notNull(),
    toState: text("to_state").notNull(),
    at: ts("at").notNull(),
  },
  (t) => [index("issuance_transitions_transaction_idx").on(t.issuanceTransactionId)],
);

/**
 * An issued attestation — **metadata only**.
 *
 * No attribute values, no credential, no SD-JWT. `engine_session_ref` is the awkward but necessary
 * field: the engine exposes status mutation only as a session-keyed call and its status-mapping
 * table has no foreign key to the session, so revocation survives a session purge only if the
 * platform kept the reference. It is internal, never returned and never logged — the revocation
 * index is an `ISSU_35` unique element.
 */
export const issuedCredentials = pgTable(
  "issued_credentials",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    issuanceTransactionId: uuid("issuance_transaction_id")
      .notNull()
      .references(() => issuanceTransactions.id, { onDelete: "restrict" }),
    credentialTypeId: uuid("credential_type_id")
      .notNull()
      .references(() => credentialTypes.id, { onDelete: "restrict" }),
    issuancePolicyId: uuid("issuance_policy_id")
      .notNull()
      .references(() => issuancePolicies.id, { onDelete: "restrict" }),
    issuancePolicyVersion: integer("issuance_policy_version").notNull(),
    status: text("status").notNull(),
    issuedAt: ts("issued_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
    engineSessionRef: text("engine_session_ref").notNull(),
    statusListUri: text("status_list_uri"),
    statusListIndex: integer("status_list_index"),
    statusChangedAt: ts("status_changed_at"),
  },
  (t) => [
    index("issued_credentials_tenant_idx").on(t.tenantId),
    index("issued_credentials_status_idx").on(t.status),
    uniqueIndex("issued_credentials_transaction_key").on(t.issuanceTransactionId),
  ],
);

/**
 * A published list of the platform's own trust anchors, per ETSI TS 119 602.
 *
 * The optional half of ARF §6.3.2.4, and **not** a notified list under Topic 31. `TEST` only in V0,
 * enforced in the domain rather than here, and labelled inside the signed payload itself.
 */
export const trustAnchorPublications = pgTable(
  "trust_anchor_publications",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    trustEnvironment: text("trust_environment").notNull(),
    schemeOperatorName: text("scheme_operator_name").notNull(),
    publicationUri: text("publication_uri").notNull(),
    sequenceNumber: integer("sequence_number").notNull(),
    issuedAt: ts("issued_at").notNull(),
    nextUpdate: ts("next_update").notNull(),
    anchors: jsonb("anchors").notNull(),
    signingKeyRef: text("signing_key_ref").notNull(),
    /**
     * Must be `trustList`. Stored so the invariant survives a round-trip: without it, a row read
     * back from the database would be a bare reference again and the domain check would have
     * nothing to act on.
     */
    signingKeyUsage: text("signing_key_usage").notNull(),
    /** The signed list as served. Public by construction; no secret is stored here. */
    signedList: text("signed_list"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("trust_anchor_publications_seq_key").on(t.tenantId, t.sequenceNumber),
    index("trust_anchor_publications_tenant_idx").on(t.tenantId),
  ],
);
