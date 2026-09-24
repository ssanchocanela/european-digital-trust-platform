-- Clear the superseded webhook secrets.
--
-- Migration 0002 moved the callback signing secret to `webhook_endpoint_secrets` and left
-- `relying_party_services.webhook_secret` in place so the backfill was reversible and an operator
-- could confirm it. That confirmation window is over, and a retained copy of a live signing secret is
-- a second place it can leak from — a `SELECT *`, a database dump, a support query. Nothing reads the
-- column any more: the repository method that did has been deleted, and the tenant-isolation test now
-- asserts against the endpoint instead.
--
-- Cleared rather than dropped, in this order deliberately:
--
--   * clearing is safe to run against a live system and takes effect immediately;
--   * dropping changes the table shape, and doing both at once would mean a single migration that
--     both destroys data and alters structure — harder to reason about if it half-applies.
--
-- The column drop is scheduled as the next schema change; see docs/eudiplo-integration.md and the
-- note at the foot of this file.

UPDATE "relying_party_services" SET "webhook_secret" = NULL WHERE "webhook_secret" IS NOT NULL;
--> statement-breakpoint

-- A row that still has no endpoint after 0002 would now have no way to sign a callback at all. That
-- is correct behaviour — the delivery path refuses to send rather than signing with something else —
-- but it should be visible rather than silent, so it is asserted here. 0002 created one endpoint per
-- Service that had a secret, so any row reaching this state was already unable to deliver.
DO $$
DECLARE orphaned integer;
BEGIN
  SELECT count(*) INTO orphaned
  FROM "relying_party_services"
  WHERE "webhook_endpoint_id" IS NULL;

  IF orphaned > 0 THEN
    RAISE NOTICE
      'edtp: % Relying Party Service(s) have no webhook endpoint. They cannot deliver callbacks; '
      'register an endpoint for them if callbacks are wanted. This is not an error.',
      orphaned;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------
-- SCHEDULED, NOT APPLIED HERE — the next schema change should be:
--
--   ALTER TABLE "relying_party_services" DROP COLUMN "webhook_secret";
--   ALTER TABLE "webhook_deliveries"     DROP COLUMN "presentation_id";
--
-- Held back one migration on purpose. `presentation_id` is still written alongside
-- `subject_id` for presentation deliveries, so dropping it needs that write removed first — and
-- doing it in the same migration as the clearing above would couple a data change to a structural
-- one. Both columns are unread today; the drop is bookkeeping, not risk.
-- ---------------------------------------------------------------------------------------
