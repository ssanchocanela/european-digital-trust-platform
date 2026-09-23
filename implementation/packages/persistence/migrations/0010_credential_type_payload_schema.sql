-- A credential type may carry a JSON Schema its assembled claims must satisfy before issuance.
--
-- A claim list says which attributes exist and the shape of each. A Rulebook also says how they
-- relate: one of two blocks and never both, a group present only when a flag says so, a closed code
-- list. The Power of X attestations were the first types to need that, and a claim definition has
-- no place for it. Definitions only, never values — like `claims`.
--
-- Nullable, and null for every existing row: a flat type has no such rules.

ALTER TABLE "credential_types"
  ADD COLUMN IF NOT EXISTS "payload_schema" jsonb;
