-- The sandbox's certificate service (S3, ADR 0014): its services' roles, the certificates it issued,
-- and every publication of its CRLs, status lists and trust lists.
--
-- Everything here is public by nature or configuration. A certificate's body is what goes into a
-- presentation or a download; no private key is stored — take-away certificates are issued against
-- a request whose key never reaches the sandbox, and the sandbox's own keys live in its sealed key
-- store, not in the database. Publications are kept, not replaced: AS-WP-31-014 (TLPub_08) asks for
-- the full history of a list.

CREATE TABLE IF NOT EXISTS "sandbox_services" (
  "relying_party_service_id" uuid PRIMARY KEY REFERENCES "relying_party_services"("id") ON DELETE CASCADE,
  "tenant_id" uuid NOT NULL REFERENCES "sandbox_organisations"("tenant_id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "support_uri" text NOT NULL,
  "privacy_policy_uri" text NOT NULL,
  "info_uri" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "sandbox_services_role_check" CHECK ("role" IN ('service_provider', 'pid_provider'))
);
CREATE INDEX IF NOT EXISTS "sandbox_services_tenant_idx" ON "sandbox_services" ("tenant_id");

-- One index space for every registration certificate status entry; each is unique per issuer
-- (ETSI TS 119 475 GEN-6.2.6.1-05) because it is unique overall.
CREATE SEQUENCE IF NOT EXISTS "sandbox_status_index_seq" START WITH 0 MINVALUE 0;

CREATE TABLE IF NOT EXISTS "sandbox_certificates" (
  "id" uuid PRIMARY KEY,
  "tenant_id" uuid NOT NULL REFERENCES "sandbox_organisations"("tenant_id") ON DELETE CASCADE,
  "relying_party_service_id" uuid NOT NULL REFERENCES "relying_party_services"("id") ON DELETE CASCADE,
  "intended_use_id" uuid REFERENCES "intended_uses"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "variant" text NOT NULL,
  -- The trust-domain key that signed it: names the CRL or status list that revokes it.
  "issuer_key" text NOT NULL,
  "serial_hex" text,
  "status_index" integer,
  "not_before" timestamp with time zone,
  "not_after" timestamp with time zone,
  -- PEM for a certificate, compact JWS for a registration certificate; null for RC-01 (absent).
  "body" text,
  "fingerprint_sha256" text,
  "dns_names" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "sandbox_certificates_kind_check" CHECK ("kind" IN ('WRPAC', 'WRPRC'))
);
CREATE INDEX IF NOT EXISTS "sandbox_certificates_tenant_idx" ON "sandbox_certificates" ("tenant_id");
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_certificates_serial_key"
  ON "sandbox_certificates" ("serial_hex") WHERE "serial_hex" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_certificates_status_index_key"
  ON "sandbox_certificates" ("status_index") WHERE "status_index" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "sandbox_publications" (
  "id" uuid PRIMARY KEY,
  -- e.g. 'lote:WRPAC', 'crl:access-ca', 'status:registrar-signing'
  "channel" text NOT NULL,
  "sequence" integer NOT NULL,
  "issued_at" timestamp with time zone NOT NULL,
  "next_update" timestamp with time zone NOT NULL,
  -- base64 for a CRL (DER), the compact JWS otherwise.
  "body" text NOT NULL,
  -- What the publication says, without its dates or signature: unchanged content is not re-issued
  -- until its next update approaches.
  "content_hash" text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_publications_channel_seq_key"
  ON "sandbox_publications" ("channel", "sequence");
