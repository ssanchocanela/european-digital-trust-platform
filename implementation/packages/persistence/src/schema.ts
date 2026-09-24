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
    webhookSecret: text("webhook_secret").notNull(),
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
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    presentationId: uuid("presentation_id")
      .notNull()
      .references(() => presentationTransactions.id, { onDelete: "cascade" }),
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
