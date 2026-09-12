-- Indexes for the list endpoints' keyset pagination.
--
-- Every list orders by `(sort column DESC, id DESC)` within one tenant, so the index that serves it is
-- `(tenant_id, sort column DESC, id DESC)`. Without it PostgreSQL scans the tenant's rows and sorts
-- them on every page — which is invisible at V0's data volumes and becomes the whole cost later, by
-- which time the endpoints are in use and the fix is a migration on a large table.
--
-- The existing `*_tenant_idx` indexes stay: they serve the scoped point reads, and a composite index
-- leading with `tenant_id` would serve those too, but dropping them is a separate decision from adding
-- these and should not ride along in a migration about pagination.
--
-- `IF NOT EXISTS` so a re-run is a no-op. Not `CONCURRENTLY`: that cannot run inside a transaction, and
-- the migrator wraps each file in one. At V0 volumes the lock is momentary; on a large table this
-- migration would need splitting.

CREATE INDEX IF NOT EXISTS "organisations_tenant_page_idx"
  ON "organisations" ("tenant_id", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "relying_party_services_tenant_page_idx"
  ON "relying_party_services" ("tenant_id", "created_at" DESC, "id" DESC);

-- Intended uses are listed within one service, so the service leads after the tenant.
CREATE INDEX IF NOT EXISTS "intended_uses_service_page_idx"
  ON "intended_uses" ("tenant_id", "relying_party_service_id", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "presentation_policies_tenant_page_idx"
  ON "presentation_policies" ("tenant_id", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "presentation_transactions_tenant_page_idx"
  ON "presentation_transactions" ("tenant_id", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "attestation_providers_tenant_page_idx"
  ON "attestation_providers" ("tenant_id", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "credential_types_tenant_page_idx"
  ON "credential_types" ("tenant_id", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "issuance_policies_tenant_page_idx"
  ON "issuance_policies" ("tenant_id", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "issuance_transactions_tenant_page_idx"
  ON "issuance_transactions" ("tenant_id", "created_at" DESC, "id" DESC);

-- The one table keyed on `issued_at` rather than `created_at`, because it has no `created_at`.
CREATE INDEX IF NOT EXISTS "issued_credentials_tenant_page_idx"
  ON "issued_credentials" ("tenant_id", "issued_at" DESC, "id" DESC);

-- The audit route reads one subject's events in order. `audit_events_subject_idx` covers
-- `(subject_type, subject_id)` but not the tenant, so a scoped read still filters afterwards.
CREATE INDEX IF NOT EXISTS "audit_events_tenant_subject_idx"
  ON "audit_events" ("tenant_id", "subject_type", "subject_id", "at");
