-- The Wallet Provider role in the sandbox (ADR 0020).
--
-- A wallet_provider service uploads the public certificate its wallet attestations chain to (a CA) or
-- are signed with (a single signer). Only that certificate is stored, never a key. It reaches the
-- sandbox's Wallet Providers list only once the operator has approved it, and leaves it when
-- withdrawn or when its organisation is suspended.

ALTER TABLE "sandbox_services" DROP CONSTRAINT IF EXISTS "sandbox_services_role_check";
ALTER TABLE "sandbox_services" ADD CONSTRAINT "sandbox_services_role_check"
  CHECK ("role" IN ('service_provider', 'pid_provider', 'wallet_provider'));

CREATE TABLE IF NOT EXISTS "sandbox_wallet_provider_anchors" (
  "id" uuid PRIMARY KEY,
  "tenant_id" uuid NOT NULL REFERENCES "sandbox_organisations"("tenant_id") ON DELETE CASCADE,
  "relying_party_service_id" uuid NOT NULL
    REFERENCES "sandbox_services"("relying_party_service_id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "certificate_der" text NOT NULL,
  "fingerprint" text NOT NULL,
  "subject" text NOT NULL,
  "not_after" timestamp with time zone NOT NULL,
  "status" text NOT NULL,
  "reason" text,
  "created_at" timestamp with time zone NOT NULL,
  "decided_at" timestamp with time zone,
  CONSTRAINT "sandbox_wallet_provider_anchors_kind_check" CHECK ("kind" IN ('ca', 'signer')),
  CONSTRAINT "sandbox_wallet_provider_anchors_status_check"
    CHECK ("status" IN ('PENDING', 'APPROVED', 'REFUSED', 'WITHDRAWN'))
);
CREATE INDEX IF NOT EXISTS "sandbox_wallet_provider_anchors_service_idx"
  ON "sandbox_wallet_provider_anchors" ("tenant_id", "relying_party_service_id");
-- One live (pending or approved) entry per certificate across the whole sandbox.
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_wallet_provider_anchors_live_key"
  ON "sandbox_wallet_provider_anchors" ("fingerprint") WHERE "status" IN ('PENDING', 'APPROVED');
