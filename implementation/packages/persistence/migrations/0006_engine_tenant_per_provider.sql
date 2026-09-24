-- One engine tenant per Attestation Provider.
--
-- The engine's `POST /issuer/config` is **tenant-scoped**: `authorization_servers`, the Credential
-- Issuer's `display`, and the registration certificate published as `issuer_info` all belong to the
-- engine tenant rather than to a credential configuration. Two Attestation Providers sharing one
-- engine tenant therefore overwrite each other's, and the registration certificate is trust gate (a)
-- — ARF §6.6.2.2 — so the failure is not cosmetic: a Wallet would be shown one provider's
-- certificate while collecting a credential issued by another.
--
-- Recorded as `docs/interop-findings.md` A20, where it was observed as authorization servers alone.
-- The constraint is what makes the platform-side composition in `issuerConfigurationInputs` sound:
-- that read answers "everything this provider needs", which is only the whole truth about the engine
-- tenant if no other provider is also writing to it.
--
-- Global rather than per platform tenant: the reference names an engine-side object, and the engine
-- has one namespace. PostgreSQL treats NULLs as distinct in a unique index, so providers that have
-- not been provisioned yet are unaffected.
--
-- Deliberately not extended to `relying_party_instances`. A Relying Party Instance and an Attestation
-- Provider on the same engine tenant write different endpoints — `/verifier/config` and
-- `/issuer/config` — and the PID-during-issuance flow *requires* the eligibility presentation
-- configuration to live on the issuing tenant, so that sharing is load-bearing rather than accidental.

-- ## The backfill, and why it clears rather than fails
--
-- Existing databases have duplicates: the development stack this was written on had **four**
-- providers on `rpi-1`, which is the defect itself rather than a migration inconvenience. The index
-- cannot be created over them and the migration has to choose.
--
-- It keeps the most recently created provider and clears the reference on the rest. That is not a
-- coin toss dressed up as a rule: only one provider's configuration is actually present in the engine
-- — whichever wrote last — so for every other provider the stored `engine_tenant_ref` is **already
-- false**. Clearing it makes the record agree with reality. Issuance from those providers then fails
-- with `attestation_provider_not_provisioned`, which names the real problem and the fix (provision
-- them onto their own engine tenants), instead of silently issuing under another provider's
-- registration certificate.
--
-- The alternative, refusing to migrate, leaves a platform that will not start and an operator with no
-- tooling to resolve it. This is a `TEST`-only V0 (`CLAUDE.md` §7); the choice would deserve
-- revisiting before any deployment holding data someone depends on.

UPDATE "attestation_providers" AS losing
SET "engine_tenant_ref" = NULL
WHERE "engine_tenant_ref" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "attestation_providers" AS winning
    WHERE winning."engine_tenant_ref" = losing."engine_tenant_ref"
      AND (winning."created_at", winning."id") > (losing."created_at", losing."id")
  );

CREATE UNIQUE INDEX IF NOT EXISTS "attestation_providers_engine_tenant_key"
  ON "attestation_providers" ("engine_tenant_ref");
