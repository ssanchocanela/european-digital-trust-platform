-- Fixture for the rollback test. The first statement succeeds and the second fails, so a
-- migrator without per-migration transactions would leave `rollback_probe` behind.
CREATE TABLE "rollback_probe" ("id" uuid PRIMARY KEY NOT NULL);
--> statement-breakpoint
CREATE TABLE "rollback_probe" ("id" uuid PRIMARY KEY NOT NULL);
