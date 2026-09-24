# ADR 0010 — Permanent demonstration environment

- **Status:** ACCEPTED, 24 September 2026.
- **Date:** 24 September 2026
- **Supersedes:** the session-only exposure rule in `CLAUDE.md` §6.20 and
  [`test-session-gateway.md`](../test-session-gateway.md), **for the demonstration environment only**.
  Test sessions from a laptop keep that rule.
- **Numbered 0010**, the next free number. 0006 stays reserved for the hosted Relying Party Instance
  versus intermediary decision (blocked on Q2); 0007–0008 are Milestone 2.
- **Detail:** [`demo-hosting-proposal.md`](../demo-hosting-proposal.md). This ADR records what is
  decided and why; the proposal holds the design.

## Context

Every demonstration so far has run from one laptop. A Cloudflare tunnel is opened by hand for each
session, and the stack exists only while the laptop is on. Two failures in one week came from that
alone:

1. A hostname created minutes earlier was cached by the home router as nonexistent. Both the session's
   negative checks and the phone failed for half an hour, while the name resolved everywhere else.
2. The status list URI of every issued attestation embeds the engine's public URL. While the engine
   is not reachable, attestations cannot have their status checked. This is why the named tunnel
   replaced quick tunnels, and it is only half solved while the named tunnel is up only during a
   session.

Demonstrations to clients need an environment that is on when the client is, and a portal from which
to choose what to show. The project's standing rule points the other way:

> A tunnel is hand-started, open only during a session, synthetic data only. — `CLAUDE.md` §6.20

That rule exists because the engine serves its Management API on the same port as the wallet-facing
Protocol API. An exposure mistake publishes `POST /api/key-chain/import` and every tenant route. The
rule limits how long such a mistake can last. A permanent environment removes that limit, so the other
controls have to carry more weight.

## Decision

### 1. One always-on VM in the EU, reached only through its own tunnel

- **Hetzner Cloud, `cx23`** (2 shared x86 vCPU, 4 GB RAM, 40 GB), in Falkenstein (`fsn1`). About
  7.25 € a month with VAT, IPv4 included, as read from the provider's pricing API on
  24 September 2026. The size comes from measurement: the whole stack at rest uses ~340 MiB. It can be
  resized in place.
- **No inbound ports.** `cloudflared` runs on the VM as a system service and connects outwards, as
  the laptop does today. SSH also goes through Cloudflare Access, and nothing listens on the public
  address. The IPv4 address is kept for outbound traffic only; GitHub's registry is not reachable over
  IPv6 alone.
- **The same hostnames on `murcata.es`.** DNS moves from the laptop's tunnel to the VM's, so
  attestations already issued keep a resolvable status list URI.
- **The same allow-list gateway**, with the same default-deny rules. It is the one source of truth for
  both deployment targets.

### 2. Public demonstrations are generic; client branding is a profile behind a login

- **Nothing reachable without credentials carries a real organisation's name, logo or colours.** This
  means a neutral PID issuer, a neutral registry, and *Banco Demo*, which is already fictional.
- **A client profile** (for example `fnmt-corpme`) switches issuer display names, logos and the hosted
  form's look for **one demonstration**, and **reverts automatically after 4 hours**. The switch is
  an operator action and is audited.
- **Behind Cloudflare Access:** the portal's private part, the profile switch, the operator console,
  and the hosted form while a client profile is on.
- **Stated residual risk:** issuer metadata is read by the wallet without authentication, so while a
  client profile is on, the client's name and emblem are publicly readable there. This is bounded by
  the 4-hour window and by "(demo)" in every name. It is acceptable **only with the organisation's
  written permission**, obtained before the profile is ever switched on.

### 3. Permanent exposure is earned with controls that session exposure did not need

1. **Rate limits at the edge**, always on: per-IP limits on PAR, token, credential, presentation
   creation, the hosted form and the bank. This is G7, which `test-session-gateway.md` §3 evaluated and
   left off for short sessions. The evaluation's reason for leaving it off, that exposure lasts
   minutes, no longer holds.
2. **The negative checks run on a schedule**, not only at start. Any answer that is not `404` alerts,
   and after a deployment it triggers a rollback.
3. **Secrets are generated on the VM**, never in the repository or on a laptop, and rotated when the
   VM is rebuilt.
4. **Nightly reset** to a known configuration, which also reverts any client profile.
5. **Monitoring:** uptime per public hostname, the negative-check alerts, disk and memory. Content is
   never logged (ADR 0004).
6. **Updates:** OS security updates are unattended. Platform deployments are built in GitHub Actions
   and deployed by the `deploy-demo` workflow, through the tunnel with an Access service token. The
   engine stays on the pinned image (`CLAUDE.md` §2).
7. **`GATEWAY_PINNED_WALLET_COMPAT`** (A29) is on permanently, because every demonstration uses the
   pinned test wallet. It is logged as today.

### 4. The wallet

- Demonstrations run on **our own Android phones**, with a clean install per client. There is no iOS
  build.
- The APK may be downloaded **behind Cloudflare Access only**. It must be a **release** build signed
  with our `OU=TEST ONLY` key, never a debug build, which logs HTTP bodies including PID contents. It
  must carry the upstream wallet's **EUPL 1.2** terms: the notices, a statement that it is modified
  and how, and a link to `tools/test-wallet/` as the source; the repository is public. It is never
  published on Google Play (`CLAUDE.md` §6.22, amended on 24 September 2026). **Legal confirmation of
  the EUPL reading comes before the first upload.**

## Considered and rejected

- **Leaving the laptop's tunnel open permanently.** This has all of the permanent environment's
  exposure and none of its controls. It also keeps both failure modes in the Context.
- **Managed container platforms** (Azure Container Apps, Cloud Run, Fly.io). Two Postgres instances
  with stable schemas, a private network between services, and an engine that bakes its public URL
  into what it issues all fit one VM trivially. On a managed platform each is extra work, and a
  demonstration gains nothing from it.
- **Hiding client branding behind the login alone.** The wallet cannot authenticate to issuer
  metadata, so this would look like protection and provide none. The profile with a time limit is the
  honest version.
- **A larger VM** (4 vCPU / 8 GB, first proposed). It was not measured, and it was more than four
  times what the stack uses.

## Consequences

- **Positive.** Demonstrations no longer depend on a laptop or a home router. Issued attestations keep
  a live status list, and the environment's state is a known commit.
- **Positive.** Each public process holds only its own narrow secret, as today. Nothing public holds a
  tenant key, and the operator console stays behind an identity gate.
- **Negative.** The Management API's protection now rests on the allow-list and the scheduled checks,
  without the time limit of a session. A regression in the gateway is caught by the next scheduled
  check and not prevented.
- **Negative.** The hosted form and the bank can be used by anyone within the rate limits. They create
  engine sessions and platform transactions, all synthetic, purged by TTL and by the nightly reset.
- **Negative.** A small running cost, and a VM to keep patched.
- **Changed on acceptance:**
  - `CLAUDE.md` §6.20: the session-only rule holds for laptop sessions; the demonstration environment
    follows this ADR;
  - `test-session-gateway.md`: a permanent deployment target;
  - `test-session-vm.md`: superseded where they differ;
  - `security-limitations.md`: a new entry for permanent exposure and its residual risks;
  - `status.md`.

## Open

1. ~~Standing authorization for `deploy-demo`~~ — **decided: every deployment is confirmed by the
   user first.**
2. Whether a second client justifies separate engine tenants per client (`demo-hosting-proposal.md`
   §4, alternative).
3. Legal confirmation of the EUPL obligations before the first APK upload.

## Status of claims

None. This is a `TEST` environment with synthetic data. It makes no claim of production readiness and
no claim of conformance with ARF 3.0.0 or any Technical Specification. Every result obtained in it is
a result of the **modified** EDTP test wallet, never "the Reference Wallet".
