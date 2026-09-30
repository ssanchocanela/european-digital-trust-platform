# ADR 0011 — The age verification demos on the demonstration VM

- **Status:** PROPOSED, 30 September 2026. Accepted when the user approves the first `deploy-av`.
- **Date:** 30 September 2026
- **Amends:** [ADR 0010](0010-permanent-demonstration-environment.md), which covers only this
  repository's stack.
- **Numbered 0011**, the next free number (0006 stays reserved; 0007–0008 are Milestone 2).

## Context

The `age_verification_platform` repository has two demo relying parties, **Lumen** (an 18+ gate) and
**Plaza** (a sign-up with age bands and a guardian path), and its own verifier. They are to be shown
publicly from Murcata, the same way the bank, the shop and the representation demos are.

That repository is a separate product. It has its own wallet (the Age Verification app, not the EDTP
test wallet), its own TEST PKI and its own rules. Nothing of this platform's is used by it, and nothing
of its is used by this platform. The demonstration VM is the one place both would meet.

The VM had about 2.7 GB of memory available on 30 September 2026. The verifier is a JVM service; Lumen
and Plaza are small Node processes.

## Decision

1. **Same VM, separate compose project.** `infra/demo-vm/av/docker-compose.yml`, project `av-demos`,
   runs the verifier, Lumen and Plaza from that repository's published images, pinned by commit
   (`AV_IMAGE_TAG`). A deployment, failure or rollback of one stack never touches the other: the EDTP
   `deploy` and the new `deploy-av` are separate verbs of the same forced command, under the same lock.
   The verifier has a 900 MB memory limit, and each demo 256 MB.

2. **Three hostnames on the VM's tunnel.** `av-lumen.murcata.es` and `av-plaza.murcata.es` are public
   whole. Their presenter controls are off (`DEMO_PRESENTER_CONTROLS=off`: no demo bar, no reset, no
   session log). `av-verifier.murcata.es` publishes **only** the three paths a wallet calls:
   `/wallet/request.jwt/{id}`, `/wallet/direct_post/{id}` and `/wallet/public-keys.json`. They are
   selected by path in the `cloudflared` ingress, and anything else on the hostname is a 404 at the
   edge. That includes `/ui/presentations`, which opens transactions without authentication, and
   `/v1/sessions`, which the demos reach on the project's own network. The negative checks probe all of
   it, as they do for this stack.

3. **The verifier's TEST PKI is generated on the VM.** `infra/demo-vm/av/setup-pki.sh` runs that
   repository's generator for `av-verifier.murcata.es` and keeps only what the verifier reads. The
   one exception is the trust store, `trusted-issuers.p12`, copied from the machine whose issuer
   issued the attestations in the wallets that will be shown. It holds certificates only, and the
   script refuses one with a private key. The API keys, their digests, the session secrets and the
   PKI password are random, in `~/.av/demos.env`, mode 600.

4. **OpenID4VP is the preferred channel there** (`DEMO_CHANNEL_PREFERENCE=oid4vp`). The demo app on
   iOS cannot use the DC API unless the device runs the latest iOS release, and has logged failures on
   that path (that repository's ADR-0025 addendum). The tenants are therefore `zkp_preferred`.

5. **Deployed like everything else here.** The `deploy-demo` workflow gains `stack: av`, behind the
   same approval. The nightly reset recreates Lumen and Plaza, which keep their data in memory. The
   portal shows their cards only once `PORTAL_SHOW_AV_DEMOS=true`.

## Consequences

- The VM runs two products' code. Their trust material is separate: the two stacks share no key,
  certificate or tenant, and neither can reach the other's management surface.
- Over OpenID4VP the wallet answers with a plain mdoc. The public age verification demos show that
  fallback, not the zero-knowledge path, and must not be presented as showing ZKP.
- The verifier trusts the Document Signer of one development issuer. A wallet holding attestations from
  another issuer is refused, correctly, and the demo reads that as "no confirmado".
- Security limitation P11 records the rest.
