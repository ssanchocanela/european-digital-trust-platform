-- The sandbox's hosted verifier and its run reports (S4, specification J5 and §6).
--
-- A run report is derived result and audit evidence, never content: it names the certificates and
-- their variants, the platform's outcome, and what the tester says the wallet did. The free-text
-- note is the participant's own words, limited, and the form says no credential value belongs in
-- it. Nothing here holds a presented value.

ALTER TABLE "sandbox_certificates" ADD COLUMN IF NOT EXISTS "mode" text NOT NULL DEFAULT 'takeaway';
ALTER TABLE "sandbox_certificates" DROP CONSTRAINT IF EXISTS "sandbox_certificates_mode_check";
ALTER TABLE "sandbox_certificates" ADD CONSTRAINT "sandbox_certificates_mode_check"
  CHECK ("mode" IN ('takeaway', 'hosted'));

CREATE TABLE IF NOT EXISTS "sandbox_verifiers" (
  "relying_party_service_id" uuid PRIMARY KEY REFERENCES "relying_party_services"("id") ON DELETE CASCADE,
  "tenant_id" uuid NOT NULL REFERENCES "sandbox_organisations"("tenant_id") ON DELETE CASCADE,
  "engine_tenant_ref" text NOT NULL,
  -- What the verifier presents now: one access certificate, and per intended use one registration
  -- certificate (or none, for RC-01).
  "access_certificate_id" uuid NOT NULL REFERENCES "sandbox_certificates"("id") ON DELETE RESTRICT,
  "configured_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_verifiers_engine_tenant_key" ON "sandbox_verifiers" ("engine_tenant_ref");
CREATE INDEX IF NOT EXISTS "sandbox_verifiers_tenant_idx" ON "sandbox_verifiers" ("tenant_id");

CREATE TABLE IF NOT EXISTS "sandbox_verifier_uses" (
  "intended_use_id" uuid PRIMARY KEY REFERENCES "intended_uses"("id") ON DELETE CASCADE,
  "relying_party_service_id" uuid NOT NULL REFERENCES "sandbox_verifiers"("relying_party_service_id") ON DELETE CASCADE,
  "registration_certificate_id" uuid NOT NULL REFERENCES "sandbox_certificates"("id") ON DELETE RESTRICT,
  "policy_id" uuid NOT NULL,
  "configured_at" timestamp with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS "sandbox_runs" (
  "id" uuid PRIMARY KEY,
  "tenant_id" uuid NOT NULL REFERENCES "sandbox_organisations"("tenant_id") ON DELETE CASCADE,
  "relying_party_service_id" uuid NOT NULL REFERENCES "relying_party_services"("id") ON DELETE CASCADE,
  "intended_use_id" uuid NOT NULL REFERENCES "intended_uses"("id") ON DELETE CASCADE,
  "presentation_id" uuid NOT NULL,
  "access_certificate_id" uuid NOT NULL REFERENCES "sandbox_certificates"("id") ON DELETE RESTRICT,
  "registration_certificate_id" uuid NOT NULL REFERENCES "sandbox_certificates"("id") ON DELETE RESTRICT,
  "interaction" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  -- The tester's observation, all optional until given.
  "wallet_build" text,
  "check_registration_certificates" text,
  "observation" text,
  "observation_note" text,
  "observed_at" timestamp with time zone,
  CONSTRAINT "sandbox_runs_interaction_check" CHECK ("interaction" IN ('SAME_DEVICE', 'QR')),
  CONSTRAINT "sandbox_runs_check_rc_check"
    CHECK ("check_registration_certificates" IS NULL OR "check_registration_certificates" IN ('on', 'off', 'unknown')),
  CONSTRAINT "sandbox_runs_note_length" CHECK ("observation_note" IS NULL OR length("observation_note") <= 500)
);
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_runs_presentation_key" ON "sandbox_runs" ("presentation_id");
CREATE INDEX IF NOT EXISTS "sandbox_runs_tenant_idx" ON "sandbox_runs" ("tenant_id");
