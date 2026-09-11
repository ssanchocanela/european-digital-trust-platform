-- The trust-list signing key's usage, stored so the separation invariant survives a round-trip.
--
-- A bare reference read back from the database would be indistinguishable from an attestation or
-- access key, leaving the domain check nothing to act on. Added as a separate migration rather than
-- folded into 0001 because an applied migration is immutable here — the checksum guard enforces it.
--
-- Backfilled to 'trustList' because that is the only value the domain ever permitted, and any
-- existing row was written through `assertPublishable`, which refuses anything else.
ALTER TABLE "trust_anchor_publications"
  ADD COLUMN "signing_key_usage" text NOT NULL DEFAULT 'trustList';
--> statement-breakpoint
-- Drop the default: every future insert must state the usage explicitly rather than inherit one.
ALTER TABLE "trust_anchor_publications" ALTER COLUMN "signing_key_usage" DROP DEFAULT;
