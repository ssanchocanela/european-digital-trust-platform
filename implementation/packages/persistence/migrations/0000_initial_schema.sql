CREATE TABLE "access_certificates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"relying_party_id" uuid NOT NULL,
	"relying_party_service_id" uuid NOT NULL,
	"key_binding_ref" text NOT NULL,
	"subject" text,
	"issuer" text,
	"not_before" timestamp with time zone,
	"not_after" timestamp with time zone,
	"trust_environment" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text,
	"policy_id" uuid,
	"policy_version" integer,
	"outcome" text,
	"correlation_id" text,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "intended_uses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"relying_party_service_id" uuid NOT NULL,
	"intended_use_identifier" text NOT NULL,
	"purpose" jsonb NOT NULL,
	"privacy_policy_uris" jsonb NOT NULL,
	"registered_credentials" jsonb NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organisations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_name" text NOT NULL,
	"official_identifiers" jsonb NOT NULL,
	"member_state" text NOT NULL,
	"is_public_sector_body" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "presentation_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"relying_party_service_id" uuid NOT NULL,
	"intended_use_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "presentation_policy_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"purpose" jsonb NOT NULL,
	"credential_requirements" jsonb NOT NULL,
	"requested_claims" jsonb NOT NULL,
	"trust_policy" jsonb NOT NULL,
	"result_policy" jsonb NOT NULL,
	"retention_policy" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "presentation_results" (
	"presentation_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"claims" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"purge_after" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "presentation_transaction_transitions" (
	"presentation_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "presentation_transaction_transitions_presentation_id_sequence_pk" PRIMARY KEY("presentation_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "presentation_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"relying_party_service_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_version" integer NOT NULL,
	"business_reference" text NOT NULL,
	"state" text NOT NULL,
	"interaction_type" text NOT NULL,
	"delivery_status" text NOT NULL,
	"callback_url" text,
	"engine_session_ref" text,
	"engine_tenant_ref" text,
	"failure_code" text,
	"sent_without_registration_certificate" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "registration_certificates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"relying_party_service_id" uuid NOT NULL,
	"intended_use_id" uuid NOT NULL,
	"jwt" text,
	"provider" text,
	"not_before" timestamp with time zone,
	"not_after" timestamp with time zone,
	"trust_environment" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relying_parties" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"registrar_assigned_identifier" text NOT NULL,
	"registrar" text NOT NULL,
	"registry_uri" text,
	"trade_name" text,
	"trust_environment" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relying_party_instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"relying_party_service_id" uuid NOT NULL,
	"engine_tenant_ref" text NOT NULL,
	"trust_environment" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relying_party_services" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"relying_party_id" uuid NOT NULL,
	"service_identifier" text NOT NULL,
	"service_trade_name" text NOT NULL,
	"description" jsonb NOT NULL,
	"callback_url_allow_list" jsonb NOT NULL,
	"webhook_secret" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"presentation_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"url" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"status" text NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_certificates" ADD CONSTRAINT "access_certificates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_certificates" ADD CONSTRAINT "access_certificates_relying_party_id_relying_parties_id_fk" FOREIGN KEY ("relying_party_id") REFERENCES "public"."relying_parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_certificates" ADD CONSTRAINT "access_certificates_relying_party_service_id_relying_party_services_id_fk" FOREIGN KEY ("relying_party_service_id") REFERENCES "public"."relying_party_services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intended_uses" ADD CONSTRAINT "intended_uses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intended_uses" ADD CONSTRAINT "intended_uses_relying_party_service_id_relying_party_services_id_fk" FOREIGN KEY ("relying_party_service_id") REFERENCES "public"."relying_party_services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_policies" ADD CONSTRAINT "presentation_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_policies" ADD CONSTRAINT "presentation_policies_relying_party_service_id_relying_party_services_id_fk" FOREIGN KEY ("relying_party_service_id") REFERENCES "public"."relying_party_services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_policies" ADD CONSTRAINT "presentation_policies_intended_use_id_intended_uses_id_fk" FOREIGN KEY ("intended_use_id") REFERENCES "public"."intended_uses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_policy_versions" ADD CONSTRAINT "presentation_policy_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_policy_versions" ADD CONSTRAINT "presentation_policy_versions_policy_id_presentation_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."presentation_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_results" ADD CONSTRAINT "presentation_results_presentation_id_presentation_transactions_id_fk" FOREIGN KEY ("presentation_id") REFERENCES "public"."presentation_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_results" ADD CONSTRAINT "presentation_results_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_transaction_transitions" ADD CONSTRAINT "presentation_transaction_transitions_presentation_id_presentation_transactions_id_fk" FOREIGN KEY ("presentation_id") REFERENCES "public"."presentation_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_transactions" ADD CONSTRAINT "presentation_transactions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_transactions" ADD CONSTRAINT "presentation_transactions_relying_party_service_id_relying_party_services_id_fk" FOREIGN KEY ("relying_party_service_id") REFERENCES "public"."relying_party_services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_transactions" ADD CONSTRAINT "presentation_transactions_policy_id_presentation_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."presentation_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_certificates" ADD CONSTRAINT "registration_certificates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_certificates" ADD CONSTRAINT "registration_certificates_relying_party_service_id_relying_party_services_id_fk" FOREIGN KEY ("relying_party_service_id") REFERENCES "public"."relying_party_services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_certificates" ADD CONSTRAINT "registration_certificates_intended_use_id_intended_uses_id_fk" FOREIGN KEY ("intended_use_id") REFERENCES "public"."intended_uses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relying_parties" ADD CONSTRAINT "relying_parties_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relying_parties" ADD CONSTRAINT "relying_parties_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relying_party_instances" ADD CONSTRAINT "relying_party_instances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relying_party_instances" ADD CONSTRAINT "relying_party_instances_relying_party_service_id_relying_party_services_id_fk" FOREIGN KEY ("relying_party_service_id") REFERENCES "public"."relying_party_services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relying_party_services" ADD CONSTRAINT "relying_party_services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relying_party_services" ADD CONSTRAINT "relying_party_services_relying_party_id_relying_parties_id_fk" FOREIGN KEY ("relying_party_id") REFERENCES "public"."relying_parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_presentation_id_presentation_transactions_id_fk" FOREIGN KEY ("presentation_id") REFERENCES "public"."presentation_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_certificates_service_idx" ON "access_certificates" USING btree ("relying_party_service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE INDEX "api_keys_tenant_idx" ON "api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "audit_events_tenant_at_idx" ON "audit_events" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE INDEX "audit_events_subject_idx" ON "audit_events" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intended_uses_identifier_key" ON "intended_uses" USING btree ("relying_party_service_id","intended_use_identifier");--> statement-breakpoint
CREATE INDEX "intended_uses_tenant_idx" ON "intended_uses" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "organisations_tenant_idx" ON "organisations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "presentation_policies_tenant_idx" ON "presentation_policies" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "presentation_policy_versions_key" ON "presentation_policy_versions" USING btree ("policy_id","version");--> statement-breakpoint
CREATE INDEX "presentation_policy_versions_tenant_idx" ON "presentation_policy_versions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "presentation_results_purge_idx" ON "presentation_results" USING btree ("purge_after");--> statement-breakpoint
CREATE INDEX "presentation_transactions_tenant_idx" ON "presentation_transactions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "presentation_transactions_state_idx" ON "presentation_transactions" USING btree ("state","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "presentation_transactions_engine_session_key" ON "presentation_transactions" USING btree ("engine_session_ref");--> statement-breakpoint
CREATE INDEX "presentation_transactions_business_ref_idx" ON "presentation_transactions" USING btree ("tenant_id","business_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_certificates_use_key" ON "registration_certificates" USING btree ("relying_party_service_id","intended_use_id");--> statement-breakpoint
CREATE INDEX "registration_certificates_tenant_idx" ON "registration_certificates" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "relying_parties_identifier_key" ON "relying_parties" USING btree ("registrar_assigned_identifier","trust_environment");--> statement-breakpoint
CREATE INDEX "relying_parties_tenant_idx" ON "relying_parties" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "relying_party_instances_service_env_key" ON "relying_party_instances" USING btree ("relying_party_service_id","trust_environment");--> statement-breakpoint
CREATE UNIQUE INDEX "relying_party_services_identifier_key" ON "relying_party_services" USING btree ("relying_party_id","service_identifier");--> statement-breakpoint
CREATE INDEX "relying_party_services_tenant_idx" ON "relying_party_services" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_event_key" ON "webhook_deliveries" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");