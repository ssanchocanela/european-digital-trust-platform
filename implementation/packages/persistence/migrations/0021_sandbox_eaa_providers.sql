-- EAA Providers in the sandbox (ADR 0023): a fourth service role, an attestation-signing certificate
-- kind for it, and the credential types a participant defines. A type version is immutable: a change
-- is a new row with the next version. Every version of a type shares its vct, which the sandbox
-- assigns under its own public address. The definition holds names, display texts and value types,
-- never a value.

ALTER TABLE "sandbox_services" DROP CONSTRAINT IF EXISTS "sandbox_services_role_check";
ALTER TABLE "sandbox_services" ADD CONSTRAINT "sandbox_services_role_check"
  CHECK ("role" IN ('service_provider', 'pid_provider', 'wallet_provider', 'eaa_provider'));

ALTER TABLE "sandbox_certificates" DROP CONSTRAINT IF EXISTS "sandbox_certificates_kind_check";
ALTER TABLE "sandbox_certificates" ADD CONSTRAINT "sandbox_certificates_kind_check"
  CHECK ("kind" IN ('WRPAC', 'WRPRC', 'PID_SIGNING', 'EAA_SIGNING'));

CREATE TABLE IF NOT EXISTS "sandbox_credential_types" (
  "id" uuid PRIMARY KEY,
  "tenant_id" uuid NOT NULL REFERENCES "sandbox_organisations"("tenant_id") ON DELETE CASCADE,
  "relying_party_service_id" uuid NOT NULL
    REFERENCES "sandbox_services"("relying_party_service_id") ON DELETE CASCADE,
  "slug" text NOT NULL,
  "version" integer NOT NULL,
  "vct" text NOT NULL,
  "definition" jsonb NOT NULL,
  -- The platform credential type and issuance policy this version became on the hosted issuer, once
  -- the issuer is configured. One engine credential configuration per version.
  "credential_type_id" uuid,
  "issuance_policy_id" uuid,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "sandbox_credential_types_slug_check" CHECK ("slug" ~ '^[a-z][a-z0-9-]{2,39}$'),
  CONSTRAINT "sandbox_credential_types_version_check" CHECK ("version" >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_credential_types_version_key"
  ON "sandbox_credential_types" ("relying_party_service_id", "slug", "version");
CREATE INDEX IF NOT EXISTS "sandbox_credential_types_tenant_idx"
  ON "sandbox_credential_types" ("tenant_id");
CREATE INDEX IF NOT EXISTS "sandbox_credential_types_vct_idx"
  ON "sandbox_credential_types" ("vct");

-- A hosted EAA issuer issues every type of its service, so it has no single type or policy: those
-- columns are the PID issuer's, and empty for an EAA issuer.
ALTER TABLE "sandbox_issuers" ALTER COLUMN "credential_type_id" DROP NOT NULL;
ALTER TABLE "sandbox_issuers" ALTER COLUMN "issuance_policy_id" DROP NOT NULL;

-- Which type version an EAA issuance was of. Empty for a PID issuance.
ALTER TABLE "sandbox_issuances" ADD COLUMN IF NOT EXISTS "credential_type_version_id" uuid
  REFERENCES "sandbox_credential_types"("id") ON DELETE SET NULL;
