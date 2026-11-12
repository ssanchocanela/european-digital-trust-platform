-- The sandbox's hosted PID issuer (S5, specification J7 and J8): one per PID Provider service, and
-- every issuance it made. Metadata only: the synthetic values a participant typed are content, passed
-- to the engine and never stored here (CLAUDE.md §5).

ALTER TABLE "sandbox_certificates" DROP CONSTRAINT IF EXISTS "sandbox_certificates_kind_check";
ALTER TABLE "sandbox_certificates" ADD CONSTRAINT "sandbox_certificates_kind_check"
  CHECK ("kind" IN ('WRPAC', 'WRPRC', 'PID_SIGNING'));

CREATE TABLE IF NOT EXISTS "sandbox_issuers" (
  "relying_party_service_id" uuid PRIMARY KEY REFERENCES "relying_party_services"("id") ON DELETE CASCADE,
  "tenant_id" uuid NOT NULL REFERENCES "sandbox_organisations"("tenant_id") ON DELETE CASCADE,
  "engine_tenant_ref" text NOT NULL,
  "attestation_provider_id" uuid NOT NULL,
  "credential_type_id" uuid NOT NULL,
  "issuance_policy_id" uuid NOT NULL,
  "signing_certificate_id" uuid NOT NULL REFERENCES "sandbox_certificates"("id") ON DELETE RESTRICT,
  "registration_certificate_id" uuid NOT NULL REFERENCES "sandbox_certificates"("id") ON DELETE RESTRICT,
  "configured_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_issuers_engine_tenant_key" ON "sandbox_issuers" ("engine_tenant_ref");
CREATE INDEX IF NOT EXISTS "sandbox_issuers_tenant_idx" ON "sandbox_issuers" ("tenant_id");

CREATE TABLE IF NOT EXISTS "sandbox_issuances" (
  "id" uuid PRIMARY KEY,
  "tenant_id" uuid NOT NULL REFERENCES "sandbox_organisations"("tenant_id") ON DELETE CASCADE,
  "relying_party_service_id" uuid NOT NULL REFERENCES "relying_party_services"("id") ON DELETE CASCADE,
  -- The platform's issuance transaction. A platform id, never an engine one.
  "issuance_id" uuid NOT NULL,
  "signing_certificate_id" uuid NOT NULL REFERENCES "sandbox_certificates"("id") ON DELETE RESTRICT,
  "registration_certificate_id" uuid NOT NULL REFERENCES "sandbox_certificates"("id") ON DELETE RESTRICT,
  "created_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_issuances_issuance_key" ON "sandbox_issuances" ("issuance_id");
CREATE INDEX IF NOT EXISTS "sandbox_issuances_tenant_idx" ON "sandbox_issuances" ("tenant_id");
