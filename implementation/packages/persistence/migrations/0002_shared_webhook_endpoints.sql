CREATE TABLE "webhook_endpoint_secrets" (
	"endpoint_id" uuid PRIMARY KEY NOT NULL,
	"secret" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"callback_url_allow_list" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relying_party_services" ALTER COLUMN "webhook_secret" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "presentation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attestation_providers" ADD COLUMN "webhook_endpoint_id" uuid;--> statement-breakpoint
ALTER TABLE "relying_party_services" ADD COLUMN "webhook_endpoint_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "webhook_endpoint_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "subject_type" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "subject_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook_endpoint_secrets" ADD CONSTRAINT "webhook_endpoint_secrets_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_endpoints_tenant_idx" ON "webhook_endpoints" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "attestation_providers" ADD CONSTRAINT "attestation_providers_webhook_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("webhook_endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relying_party_services" ADD CONSTRAINT "relying_party_services_webhook_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("webhook_endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("webhook_endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_subject_idx" ON "webhook_deliveries" USING btree ("subject_type","subject_id");--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Data migration. The DDL above is only half the change.
--
-- Every existing Relying Party Service carries a webhook secret and an allow-list of its own.
-- Each becomes one webhook endpoint, so no configuration is lost and no existing delivery
-- changes the secret it will be signed with.
--
-- Deterministic ids: the endpoint id is derived from the service id with `uuid_generate_v5`-style
-- overwriting of the version nibble, so re-running this migration on a restored backup produces
-- the same ids. Done with `md5` rather than the uuid-ossp extension, which is not guaranteed to be
-- installed and which a migration should not install on a database it does not own.
-- ---------------------------------------------------------------------------------------

INSERT INTO "webhook_endpoints" ("id", "tenant_id", "name", "callback_url_allow_list", "created_at")
SELECT
  -- A v5-shaped uuid derived from the service id, namespaced so it cannot collide with a real one.
  (
    overlay(
      overlay(md5('edtp-webhook-endpoint:' || s."id"::text) placing '5' from 13 for 1)
      placing '8' from 17 for 1
    )
  )::uuid,
  s."tenant_id",
  'Migrated from Relying Party Service ' || s."service_trade_name",
  s."callback_url_allow_list",
  s."created_at"
FROM "relying_party_services" s
WHERE s."webhook_secret" IS NOT NULL;
--> statement-breakpoint

INSERT INTO "webhook_endpoint_secrets" ("endpoint_id", "secret")
SELECT
  (
    overlay(
      overlay(md5('edtp-webhook-endpoint:' || s."id"::text) placing '5' from 13 for 1)
      placing '8' from 17 for 1
    )
  )::uuid,
  s."webhook_secret"
FROM "relying_party_services" s
WHERE s."webhook_secret" IS NOT NULL;
--> statement-breakpoint

UPDATE "relying_party_services" s
SET "webhook_endpoint_id" = (
  overlay(
    overlay(md5('edtp-webhook-endpoint:' || s."id"::text) placing '5' from 13 for 1)
    placing '8' from 17 for 1
  )
)::uuid
WHERE s."webhook_secret" IS NOT NULL;
--> statement-breakpoint

-- In-flight deliveries keep working: each is pointed at the endpoint derived from the Relying Party
-- Service of its presentation, which is exactly the secret it would have been signed with before.
-- A retry after this migration therefore produces the same signature as one before it.
UPDATE "webhook_deliveries" d
SET
  "webhook_endpoint_id" = s."webhook_endpoint_id",
  "subject_type" = 'presentation',
  "subject_id" = d."presentation_id"
FROM "presentation_transactions" t
JOIN "relying_party_services" s ON s."id" = t."relying_party_service_id"
WHERE d."presentation_id" = t."id" AND d."webhook_endpoint_id" IS NULL;
