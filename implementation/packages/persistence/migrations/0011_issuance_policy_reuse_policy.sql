-- An issuance policy version may state how often a Wallet Unit may present one issued credential.
--
-- ARF 3.0.0 `AS-AP-10-070` (`ISSU_38`) makes this the provider's policy, and `AS-AP-10-084`
-- (`ISSU_50`) has the provider tell the Wallet Unit through the `credential_reuse_policy` metadata
-- parameter of ETSI TS 119 472-3. Without it the Wallet applies its own default, which for a PID in
-- the pinned wallet is once-only — one credential, spent by its first presentation.
--
-- Nullable, and null for every existing row: those versions publish no policy, as before.

ALTER TABLE "issuance_policy_versions"
  ADD COLUMN IF NOT EXISTS "reuse_policy" jsonb;
