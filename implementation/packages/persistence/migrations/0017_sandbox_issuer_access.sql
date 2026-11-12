-- Signed issuer metadata for the sandbox's hosted PID issuers (S5b, ADR 0016).
--
-- Each hosted issuer gets an access certificate from the sandbox Access CA whose key the sandbox keeps
-- in its sealed key store, to sign the issuer's metadata (ETSI TS 119 472-3: the signing certificate
-- is the access certificate). Stored here: which certificate, and the key's name in the store — never
-- the key. Nullable: issuers configured before S5b have neither until they are reconfigured.

ALTER TABLE "sandbox_issuers" ADD COLUMN IF NOT EXISTS "access_certificate_id" uuid
  REFERENCES "sandbox_certificates"("id") ON DELETE RESTRICT;
ALTER TABLE "sandbox_issuers" ADD COLUMN IF NOT EXISTS "access_key_name" text;
