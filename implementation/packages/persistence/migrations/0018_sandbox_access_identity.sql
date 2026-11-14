-- Sandbox sign-in by the Access identity; the PID becomes optional (ADR 0018).
--
-- A person is now known by the e-mail address Cloudflare Access verified, normalised to lower case.
-- The PID-derived pseudonymous subject stays, nullable: it is recorded only when the person chooses
-- to present a PID. A laptop database's PID-only people keep their rows, with no address, and can no
-- longer sign in (ADR 0018 Decision 8); the deployed sandbox had none.

ALTER TABLE "sandbox_people" ADD COLUMN IF NOT EXISTS "email" text;
ALTER TABLE "sandbox_people" ALTER COLUMN "subject" DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_people_email_key" ON "sandbox_people" ("email");

-- An invitation names the address that may accept it. Earlier invitations have none and cannot be
-- accepted any more.
ALTER TABLE "sandbox_invitations" ADD COLUMN IF NOT EXISTS "email" text;

-- A sign-in attempt is now only ever a signed-in person presenting a PID. Attempts live ten minutes,
-- so the old kinds are dropped rather than carried.
DELETE FROM "sandbox_sign_in_attempts" WHERE "purpose" <> 'present_pid';
ALTER TABLE "sandbox_sign_in_attempts" DROP CONSTRAINT IF EXISTS "sandbox_sign_in_attempts_purpose_check";
ALTER TABLE "sandbox_sign_in_attempts" ADD CONSTRAINT "sandbox_sign_in_attempts_purpose_check"
  CHECK ("purpose" IN ('present_pid'));
ALTER TABLE "sandbox_sign_in_attempts" ADD COLUMN IF NOT EXISTS "person_id" uuid
  REFERENCES "sandbox_people"("id") ON DELETE CASCADE;
