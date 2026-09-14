-- An Attestation Provider's own access certificate.
--
-- The §7.3 flow asks a Wallet for a PID before issuing. In that exchange the **issuer is the Relying
-- Party**: it sends a signed presentation request, and a Wallet Unit accepts only an access
-- certificate chaining to an anchor from a notified list — `AS-WP-06-005` (`RPA_04`). The certificate
-- that signs it must therefore be the Attestation Provider's, not that of whichever Relying Party
-- authored the policy being reused as the gate.
--
-- The platform had no field for it. `provisionAttestationProvider` accepted an attestation-signing
-- certificate only, and the flow worked on the development stack because `rpi-1` serves as both a
-- Relying Party Instance and an Attestation Provider, so a Relying Party's access key chain was
-- already on the engine tenant the issuer looked at. `docs/interop-findings.md` A22.
--
-- Nullable, and deliberately so: a provider that never gates issuance on a presentation needs none,
-- and `CLAUDE.md` §6.21 notes the access certificate is obtained at registration anyway. A provider
-- with a gating policy and no certificate is refused at provisioning with a message naming the gap,
-- rather than emitting a request no Wallet would accept.

ALTER TABLE "attestation_providers"
  ADD COLUMN IF NOT EXISTS "access_key_binding_ref" text;
