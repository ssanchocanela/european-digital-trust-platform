-- When the engine acknowledged an attestation's current status.
--
-- `changeCredentialStatus` decides, persists, and *then* tells the engine. The comment defending
-- that order argued that if the engine call fails "the platform's record and the engine's disagree,
-- and the platform's is the stricter one, which is the safe direction".
--
-- On 16 September 2026 that stopped being hypothetical. The engine returned 500 to every status
-- change (`interop-findings.md` A26) and the register read `REVOKED` for an attestation whose status
-- list had never been touched — while the same API call returned `engine_unavailable` to the caller.
-- Three parties, three answers.
--
-- **The stated rationale does not hold.** A Relying Party reads the *engine's* status list, not this
-- register, so an attestation the platform calls revoked keeps verifying as valid everywhere it
-- matters. A stricter local record protects nobody; it only makes the operator believe a revocation
-- took effect when it did not.
--
-- The ordering is kept — persisting first is what makes the transition atomic against concurrent
-- callers, and the repository pins the prior status in its `WHERE` clause — but the record now says
-- whether the engine agreed. Null means the current status has not been acknowledged: the platform
-- intends it, and the status list may not carry it.
--
-- Deliberately NOT a retry queue. V0 is a modular monolith and does not grow machinery for a case
-- that is now rare (`CLAUDE.md` §3.7); the status call is idempotent, so retrying is repeating it.
-- What was missing was not automation, it was honesty about the state.
--
-- Backfill: every existing row is marked confirmed at its last status change, or at issuance for a
-- row that never changed. That is the truthful reading for rows written before this column existed —
-- with one known exception, the single attestation revoked during the A26 outage on the development
-- database, which no production deployment has.

ALTER TABLE "issued_credentials"
  ADD COLUMN IF NOT EXISTS "status_confirmed_at" timestamptz;

UPDATE "issued_credentials"
   SET "status_confirmed_at" = COALESCE("status_changed_at", "issued_at")
 WHERE "status_confirmed_at" IS NULL;
