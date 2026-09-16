-- When an Attestation Provider's certificates stop working.
--
-- The platform holds no key material: a certificate is imported into the engine and the platform
-- keeps only an opaque key-chain reference. That is the right privacy posture and it left a real
-- blind spot — the platform could not answer "can this provider still sign?", because everything it
-- knows about the signing key is a string the engine issued.
--
-- On 16 September 2026 the answer had been *no* for a day and nothing said so. The smoke test minted
-- the attestation-signing certificate with `-days 2`; the chain was provisioned on the 13th, so it
-- expired on the 15th. Every step still answered 200 — the credential offer minted, resolved over
-- public HTTPS, the token endpoint issued a DPoP-bound access token, the nonce endpoint answered —
-- and the truth appeared only at the last call of the flow:
--
--     400 credential_request_denied
--     Certificate validation failed: Certificate expired on 2026-09-15T08:19:35.000Z
--
-- `GET …/provider-authentication` said nothing about it, because that report answers trust gate (a)
-- — signed metadata and the registration certificate — and this is the attestation key. So the
-- console showed an issuer blocked only by B7 while it had not been able to sign anything for a day.
--
-- These two columns are the smallest thing that closes it: the `notAfter` of each supplied leaf,
-- read at provisioning and stored. A validity window is not key material, not a credential and not
-- content — it is the same class of fact as `registration_certificate_not_after`, which has been on
-- this table since migration 0001.
--
-- Both nullable. A provider provisioned before this migration has no recorded validity, and the
-- report says "unknown" rather than inventing one — re-provision to record it. Null is also correct
-- for a provider with no access certificate at all, which is every provider that does not gate
-- issuance on a presentation.

ALTER TABLE "attestation_providers"
  ADD COLUMN IF NOT EXISTS "signing_certificate_not_after" timestamptz;

ALTER TABLE "attestation_providers"
  ADD COLUMN IF NOT EXISTS "access_certificate_not_after" timestamptz;
