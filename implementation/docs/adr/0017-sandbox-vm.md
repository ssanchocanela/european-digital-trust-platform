# ADR 0017 — The sandbox VM

- **Status:** PROPOSED, 12 November 2026. The four choices below were made by the user on 12 November
  2026 (hostnames, who may sign up, reset, backups). Acceptance is the S6 checkpoint. **Nothing is
  deployed:** every deployment is confirmed by the user first.
- **Date:** 12 November 2026
- **Follows:** [ADR 0010](0010-permanent-demonstration-environment.md) — the permanent demonstration
  environment, whose pattern this carries over; and sandbox decision **D7**
  ([`s0-findings.md`](../sandbox/s0-findings.md)), *a VM of its own*.
- **Context documents:** [`specification.md`](../sandbox/specification.md) §8.4 and §11;
  [`test-session-gateway.md`](../test-session-gateway.md) §1b; [`infra/sandbox-vm/`](../../infra/sandbox-vm/README.md).
- **Numbered 0017**, after the sandbox's 0014–0016.

## Context

The sandbox (S2–S5b) runs only on a laptop, behind a hand-started tunnel. Participants cannot use it
that way. It needs to be on when they are, and it has one thing the demonstration environment does not:
**state that must survive.** It has the sandbox's CA keys, the participants' accounts, and the
certificates, CRLs and status lists already issued. A demonstration can be reset every night; the
sandbox cannot.

D7 decided where it runs: on a VM of its own, built like the demonstration environment. The sandbox
changes and redeploys far more often than a demonstration may, and a sandbox participant must never be
one deployment away from the demonstrations' hostnames.

## Decision

### 1. One VM, built as ADR 0010's, with its own tunnel

- **Hetzner Cloud `cx23`, `fsn1`, Ubuntu 24.04 LTS**, created by the demonstration VM's
  `create-server.sh` with its own name (`edtp-sandbox`), key directory and role. The same
  `cloud-init.yaml` hardening applies.
- **No inbound ports**, once bootstrapped. Everything, SSH included, goes through the VM's own tunnel,
  `edtp-sandbox`, which is separate from `edtp-demo`.
- **Hostnames on `murcata.es`** (decided):

  | Hostname | Reaches | Public? |
  |---|---|---|
  | `sandbox.murcata.es` | The portal (3300) | **Behind Cloudflare Access** (§2) |
  | `sandbox-engine.murcata.es` | The engine's wallet-facing paths, through the gateway (3010) | Yes: a wallet calls them |
  | `sandbox-platform.murcata.es` | The platform's public paths, through the gateway (3011): `/sandbox/public/…` (lists, CRLs, status lists, register, CPS, signed issuer metadata) and the same-device return | Yes: a wallet fetches them |
  | `sandbox-ssh.murcata.es` | SSH | Behind Access, operator only |

- **The same allow-list gateway**, with the same default-deny rules
  ([`test-session-gateway.md`](../test-session-gateway.md) §1). The sandbox's paths (§1b) are already
  in it. **No rule is added for this VM.** `GATEWAY_SANDBOX_SIGNED_METADATA` is `on` here (ADR 0016),
  and `GATEWAY_PINNED_WALLET_COMPAT` is on, as on the demonstration VM.
- **Its own compose file,** `infra/sandbox-vm/docker-compose.sandbox.yml`. It runs only:
  - the two databases;
  - the engine;
  - the platform;
  - the portal;
  - the gateway.

  The engine block repeats the root file's. A unit test fails if the pinned digest or the ADR 0004
  retention settings drift.

### 2. Invited participants only, behind Cloudflare Access (decided)

- **The whole portal is behind an Access application** whose policy lists the invited participants'
  e-mail addresses. The operator keeps that list. The portal also refuses any request without Access's
  identity header (`SANDBOX_PORTAL_REQUIRE_ACCESS`), as the demonstration portal does for `/operador`.
- **What a wallet calls stays public, as it must.** The engine's wallet-facing paths and the
  sandbox's public reads cannot sit behind a login: a wallet does not authenticate to a trust list.
- **Opening sign-up to anyone with a PID** is a later decision, taken once the quotas and rate limits
  have been in use.
- **Sign-in still needs a PID.** Access decides who may *reach* the portal. The PID decides who
  someone *is* in it, as ADR 0015 decides. Neither replaces the other.
- **Same-device sign-in on a phone** passes Access in the phone's browser first. The run sheets say
  so.

### 3. Abuse controls before exposure

Built in S6, before anything is exposed:

- **Quotas per organisation** (specification §8.3, §11). They are checked before any side effect:
  - 3 hosted verifiers and 1 hosted issuer;
  - 10 services;
  - per service, over the last 24 hours: 100 certificates, 100 PID offers and 200 runs.
- **Edge rate limits per client address:** the gateway's existing limits (ADR 0010 §3.1), keyed on
  `CF-Connecting-IP`.
- **The operator's suspension** (specification J9). `sandbox-operator-cli.js suspend <SB:CC-n>` marks an
  organisation suspended and revokes every certificate it holds; nothing more can be created for it.
  It is final in v1.
- **Scheduled negative checks every 15 minutes.** They check that:
  - every forbidden path is a `404`;
  - publicly, the portal answers with a redirect to the Access login;
  - on loopback, the portal answers `403`.

  Anything else is an exposure: the tunnel is stopped and the operator alerted, as on the
  demonstration VM.

### 4. No scheduled reset; nightly backups (decided)

- **Nothing is wiped on a schedule.** The engine purges its own sessions (`SESSION_TTL`, anonymised).
  The platform's jobs purge expired transactions.
- **A full reset is an operator action, done by hand, with notice to participants.** It means a new
  trust domain and deleted accounts, and every sandbox wallet build then needs new lists.
- **Backups:**
  - `nightly-backup.sh` writes both database dumps and the **sealed** key store to
    `/var/backups/edtp-sandbox` every night and before every deployment, and keeps 14;
  - **Hetzner's daily server backups**, 7 kept, carry them off the VM;
  - `SANDBOX_KEYSTORE_KEY` is never in a backup. The operator keeps a copy outside the VM, in a
    password manager. Without it, the sealed keys open nothing.

### 5. Deployment, only after the user confirms it

- **The `deploy-sandbox` workflow** runs the same `edtp-platform` image the demonstration VM runs (a
  12-hex `demo-image` tag).
  - It waits on the GitHub environment `sandbox`, whose required reviewer is the repository owner and
    which admits only `main`.
  - It reaches `sandbox-ssh.murcata.es` with an Access service token and a deploy key that can run only
    `deploy.sh`.
- **On the VM,** `deploy.sh`:
  1. takes a backup;
  2. switches the image;
  3. waits for the platform to be healthy;
  4. runs the negative checks on loopback;
  5. if they fail, rolls back.
- **Secrets are generated on the VM** (`generate-secrets.sh`), never on a laptop.
- **The first deployment** is a fresh trust domain, not a migration of the laptop's: the sandbox has
  no participants yet.

### 6. The sandbox wallet build, behind Access

- **Where:** the portal's `/wallet` page, behind the same Access application.
- **What:** a **release** build signed with our `OU=TEST ONLY` key, with the EUPL 1.2 notices and the
  statement that it is modified and how (CLAUDE.md §6.22, ADR 0010 §4).
- **The portal offers it only when** the operator's `wallet.json`:
  - records the **legal confirmation of the EUPL reading** (ADR 0010 Open 3), which is still open;
  - lists the build as `release`, with its SHA-256 and its notice.

  Until then the page says the build is not yet published.

## Considered and rejected

- **The demonstration VM, beside the demos.** Rejected at D7: the sandbox redeploys too often and
  holds state that must not be reset nightly.
- **An overlay of the root `docker-compose.yml`, as the demonstration VM uses.** The root file requires
  the demonstrations' secrets and defines their processes. A self-contained file plus a drift test is
  smaller and safer.
- **Opening sign-up to anyone with a PID from the first deployment.** Rejected by the user for now:
  quotas and rate limits have not yet been in use.
- **A weekly full reset.** Rejected by the user: participants would lose their certificates and
  accounts every week.
- **A separate Storage Box, or pulling backups to a laptop.** More set-up, or dependent on someone
  remembering. Hetzner's server backups carry the nightly dumps off the VM at a small cost.

## Consequences

- **Positive.** Participants can use the sandbox without a laptop being on. Issued certificates keep
  resolvable CRLs and status lists. The portal is reachable by invited people only, and the abuse
  controls are in place before anything is exposed.
- **Negative.** A second VM to patch and pay for: about 7.25 € a month, plus 20 % for backups.
- **Negative.** The engine's and the platform's public paths rest on the allow-list and the scheduled
  checks, as on the demonstration VM. A gateway regression is caught by the next check, not
  prevented.
- **Negative.** The CA keys live sealed on a VM without an HSM (SB1). The backups hold them sealed,
  and the key is kept apart.
- **Changed on acceptance:**
  - `CLAUDE.md` §6.20: the permanent demonstration environment is no longer the only always-on tunnel;
    the sandbox VM follows this ADR on the same terms;
  - `security-limitations.md` (SB5, SB6, SB14–SB16);
  - `test-session-gateway.md` §2;
  - the sandbox plan;
  - `CLAUDE.md`'s phase table and ADR index;
  - `status.md`.

## Open

1. **Legal confirmation of the EUPL reading**, before any build is offered (carried over from ADR 0010).
2. **When to open sign-up** beyond invited participants.
3. **Brought-in PID anchors with operator approval** (v1.1, plan).

## Status of claims

None. This is a `TEST` environment with synthetic data. It makes no claim of production readiness, and
no claim of conformance with ARF 3.0.0 or any Technical Specification. Every result obtained in it is a
result of the **modified** EDTP sandbox wallet build, never "the Reference Wallet".
