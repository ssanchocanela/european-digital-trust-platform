-- Testing wallets (ADR 0022): a plan run takes one declared wallet build through a fixed list of the
-- sandbox's existing hosted-verifier and hosted-issuer runs. A step points at the run or issuance it
-- started; the server's observation is read from that, never stored twice. The tester's observation
-- is the participant's own words, which the form says hold no credential values.

CREATE TABLE IF NOT EXISTS "sandbox_wallet_test_runs" (
  "id" uuid PRIMARY KEY,
  "tenant_id" uuid NOT NULL REFERENCES "sandbox_organisations"("tenant_id") ON DELETE CASCADE,
  "relying_party_service_id" uuid NOT NULL
    REFERENCES "sandbox_services"("relying_party_service_id") ON DELETE CASCADE,
  "plan_id" text NOT NULL,
  "plan_version" integer NOT NULL,
  "provider" text NOT NULL,
  "build" text NOT NULL,
  "platform" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "sandbox_wallet_test_runs_declared_length"
    CHECK (length("provider") <= 200 AND length("build") <= 200 AND length("platform") <= 100)
);
CREATE INDEX IF NOT EXISTS "sandbox_wallet_test_runs_tenant_idx"
  ON "sandbox_wallet_test_runs" ("tenant_id", "created_at");

CREATE TABLE IF NOT EXISTS "sandbox_wallet_test_steps" (
  "plan_run_id" uuid NOT NULL REFERENCES "sandbox_wallet_test_runs"("id") ON DELETE CASCADE,
  "step_index" integer NOT NULL,
  -- The sandbox run (verifier) or sandbox issuance (issuer) the step started.
  "ref_id" uuid NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "observation" text,
  "note" text,
  "observed_at" timestamp with time zone,
  PRIMARY KEY ("plan_run_id", "step_index"),
  CONSTRAINT "sandbox_wallet_test_steps_note_length" CHECK ("note" IS NULL OR length("note") <= 500)
);
