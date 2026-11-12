-- The EUDI ecosystem sandbox: participant organisations, people, membership, invitations, sessions
-- and sign-in attempts (ADR 0015).
--
-- No column holds a PID value. A person is a pseudonymous subject — an HMAC from the
-- `PseudonymousSubject` derivation — and the display name they typed. Session, invitation and
-- browser-binding tokens are stored only as SHA-256 hashes, so a dump yields no usable credential.

CREATE SEQUENCE IF NOT EXISTS "sandbox_organisation_number_seq" START WITH 1;

CREATE TABLE IF NOT EXISTS "sandbox_organisations" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "organisation_id" uuid NOT NULL REFERENCES "organisations"("id") ON DELETE RESTRICT,
  "number" integer NOT NULL,
  "local_identifier" text NOT NULL,
  "country" text NOT NULL,
  "declared_euid" text,
  "status" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "suspended_at" timestamp with time zone,
  CONSTRAINT "sandbox_organisations_status_check" CHECK ("status" IN ('ACTIVE', 'SUSPENDED')),
  CONSTRAINT "sandbox_organisations_country_check" CHECK ("country" ~ '^[A-Z]{2}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_organisations_number_key"
  ON "sandbox_organisations" ("number");
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_organisations_local_identifier_key"
  ON "sandbox_organisations" ("local_identifier");

CREATE TABLE IF NOT EXISTS "sandbox_people" (
  "id" uuid PRIMARY KEY,
  "subject" text NOT NULL,
  "display_name" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "last_sign_in_at" timestamp with time zone NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_people_subject_key" ON "sandbox_people" ("subject");

CREATE TABLE IF NOT EXISTS "sandbox_memberships" (
  "tenant_id" uuid NOT NULL REFERENCES "sandbox_organisations"("tenant_id") ON DELETE CASCADE,
  "person_id" uuid NOT NULL REFERENCES "sandbox_people"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "person_id"),
  CONSTRAINT "sandbox_memberships_role_check" CHECK ("role" IN ('owner', 'member'))
);
CREATE INDEX IF NOT EXISTS "sandbox_memberships_person_idx" ON "sandbox_memberships" ("person_id");

CREATE TABLE IF NOT EXISTS "sandbox_invitations" (
  "id" uuid PRIMARY KEY,
  "tenant_id" uuid NOT NULL REFERENCES "sandbox_organisations"("tenant_id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "role" text NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "sandbox_people"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "accepted_by" uuid REFERENCES "sandbox_people"("id") ON DELETE SET NULL,
  CONSTRAINT "sandbox_invitations_role_check" CHECK ("role" IN ('owner', 'member'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_invitations_token_key" ON "sandbox_invitations" ("token_hash");
CREATE INDEX IF NOT EXISTS "sandbox_invitations_tenant_idx" ON "sandbox_invitations" ("tenant_id");

CREATE TABLE IF NOT EXISTS "sandbox_sessions" (
  "token_hash" text PRIMARY KEY,
  "person_id" uuid NOT NULL REFERENCES "sandbox_people"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "sandbox_sessions_person_idx" ON "sandbox_sessions" ("person_id");

CREATE TABLE IF NOT EXISTS "sandbox_sign_in_attempts" (
  "id" uuid PRIMARY KEY,
  "binding_hash" text NOT NULL,
  "purpose" text NOT NULL,
  "invitation_id" uuid REFERENCES "sandbox_invitations"("id") ON DELETE CASCADE,
  "presentation_id" uuid NOT NULL,
  -- Set when the presentation verified a person not yet known: the pseudonymous subject, held until
  -- the profile step creates the person. Derived result, never a PID value.
  "subject" text,
  "created_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "sandbox_sign_in_attempts_purpose_check"
    CHECK ("purpose" IN ('sign_in', 'sign_up', 'accept_invitation'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_sign_in_attempts_presentation_key"
  ON "sandbox_sign_in_attempts" ("presentation_id");
