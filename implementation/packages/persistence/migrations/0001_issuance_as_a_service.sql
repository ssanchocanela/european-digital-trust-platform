CREATE TABLE "attestation_providers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"registrar_assigned_identifier" text NOT NULL,
	"registrar" text,
	"signing_key_binding_ref" text,
	"registration_certificate_jwt" text,
	"registration_certificate_not_after" timestamp with time zone,
	"engine_tenant_ref" text,
	"trust_environment" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credential_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"attestation_provider_id" uuid NOT NULL,
	"name" text NOT NULL,
	"format" text NOT NULL,
	"vct" text,
	"doctype" text,
	"rulebook_identifier" text NOT NULL,
	"rulebook_version" text NOT NULL,
	"rulebook_publication_uri" text,
	"rulebook_anchor_source" text NOT NULL,
	"claims" jsonb NOT NULL,
	"display" jsonb NOT NULL,
	"validity_seconds" integer NOT NULL,
	"status_mechanism" text NOT NULL,
	"requires_key_binding" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issuance_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"credential_type_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issuance_policy_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"credential_type_id" uuid NOT NULL,
	"purpose" jsonb NOT NULL,
	"eligibility_rule" jsonb NOT NULL,
	"authentic_source" jsonb NOT NULL,
	"holder_binding" text NOT NULL,
	"flow" text NOT NULL,
	"credential_validity_seconds" integer NOT NULL,
	"status_policy" jsonb NOT NULL,
	"retention_policy" jsonb NOT NULL,
	"eligibility_presentation_policy_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "issuance_transaction_transitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"issuance_transaction_id" uuid NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issuance_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_version" integer NOT NULL,
	"credential_type_id" uuid NOT NULL,
	"state" text NOT NULL,
	"business_reference" text,
	"subject_reference" text NOT NULL,
	"authentic_source_kind" text,
	"eligibility_reason" text,
	"engine_session_ref" text,
	"engine_tenant_ref" text,
	"sent_without_registration_certificate" boolean,
	"callback_url" text,
	"delivery_status" text NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"provider_side_failure" boolean,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issued_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"issuance_transaction_id" uuid NOT NULL,
	"credential_type_id" uuid NOT NULL,
	"issuance_policy_id" uuid NOT NULL,
	"issuance_policy_version" integer NOT NULL,
	"status" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"engine_session_ref" text NOT NULL,
	"status_list_uri" text,
	"status_list_index" integer,
	"status_changed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "trust_anchor_publications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trust_environment" text NOT NULL,
	"scheme_operator_name" text NOT NULL,
	"publication_uri" text NOT NULL,
	"sequence_number" integer NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"next_update" timestamp with time zone NOT NULL,
	"anchors" jsonb NOT NULL,
	"signing_key_ref" text NOT NULL,
	"signed_list" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attestation_providers" ADD CONSTRAINT "attestation_providers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attestation_providers" ADD CONSTRAINT "attestation_providers_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_types" ADD CONSTRAINT "credential_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_types" ADD CONSTRAINT "credential_types_attestation_provider_id_attestation_providers_id_fk" FOREIGN KEY ("attestation_provider_id") REFERENCES "public"."attestation_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_policies" ADD CONSTRAINT "issuance_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_policies" ADD CONSTRAINT "issuance_policies_credential_type_id_credential_types_id_fk" FOREIGN KEY ("credential_type_id") REFERENCES "public"."credential_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_policy_versions" ADD CONSTRAINT "issuance_policy_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_policy_versions" ADD CONSTRAINT "issuance_policy_versions_policy_id_issuance_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."issuance_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_policy_versions" ADD CONSTRAINT "issuance_policy_versions_credential_type_id_credential_types_id_fk" FOREIGN KEY ("credential_type_id") REFERENCES "public"."credential_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_policy_versions" ADD CONSTRAINT "issuance_policy_versions_eligibility_presentation_policy_id_presentation_policies_id_fk" FOREIGN KEY ("eligibility_presentation_policy_id") REFERENCES "public"."presentation_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_transaction_transitions" ADD CONSTRAINT "issuance_transaction_transitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_transaction_transitions" ADD CONSTRAINT "issuance_transaction_transitions_issuance_transaction_id_issuance_transactions_id_fk" FOREIGN KEY ("issuance_transaction_id") REFERENCES "public"."issuance_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_transactions" ADD CONSTRAINT "issuance_transactions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_transactions" ADD CONSTRAINT "issuance_transactions_policy_id_issuance_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."issuance_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_transactions" ADD CONSTRAINT "issuance_transactions_credential_type_id_credential_types_id_fk" FOREIGN KEY ("credential_type_id") REFERENCES "public"."credential_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_credentials" ADD CONSTRAINT "issued_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_credentials" ADD CONSTRAINT "issued_credentials_issuance_transaction_id_issuance_transactions_id_fk" FOREIGN KEY ("issuance_transaction_id") REFERENCES "public"."issuance_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_credentials" ADD CONSTRAINT "issued_credentials_credential_type_id_credential_types_id_fk" FOREIGN KEY ("credential_type_id") REFERENCES "public"."credential_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_credentials" ADD CONSTRAINT "issued_credentials_issuance_policy_id_issuance_policies_id_fk" FOREIGN KEY ("issuance_policy_id") REFERENCES "public"."issuance_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_anchor_publications" ADD CONSTRAINT "trust_anchor_publications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attestation_providers_identifier_key" ON "attestation_providers" USING btree ("registrar_assigned_identifier","trust_environment");--> statement-breakpoint
CREATE INDEX "attestation_providers_tenant_idx" ON "attestation_providers" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "credential_types_tenant_idx" ON "credential_types" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "credential_types_provider_idx" ON "credential_types" USING btree ("attestation_provider_id");--> statement-breakpoint
CREATE INDEX "issuance_policies_tenant_idx" ON "issuance_policies" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issuance_policy_versions_key" ON "issuance_policy_versions" USING btree ("policy_id","version");--> statement-breakpoint
CREATE INDEX "issuance_policy_versions_tenant_idx" ON "issuance_policy_versions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "issuance_transitions_transaction_idx" ON "issuance_transaction_transitions" USING btree ("issuance_transaction_id");--> statement-breakpoint
CREATE INDEX "issuance_transactions_tenant_idx" ON "issuance_transactions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "issuance_transactions_state_idx" ON "issuance_transactions" USING btree ("state");--> statement-breakpoint
CREATE INDEX "issuance_transactions_expiry_idx" ON "issuance_transactions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "issued_credentials_tenant_idx" ON "issued_credentials" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "issued_credentials_status_idx" ON "issued_credentials" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "issued_credentials_transaction_key" ON "issued_credentials" USING btree ("issuance_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_anchor_publications_seq_key" ON "trust_anchor_publications" USING btree ("tenant_id","sequence_number");--> statement-breakpoint
CREATE INDEX "trust_anchor_publications_tenant_idx" ON "trust_anchor_publications" USING btree ("tenant_id");