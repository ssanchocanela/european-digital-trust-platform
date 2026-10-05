# Demonstration VM

The always-on demonstration environment of [ADR 0010](../../docs/adr/0010-permanent-demonstration-environment.md).
Design: [`docs/demo-hosting-proposal.md`](../../docs/demo-hosting-proposal.md).

| | |
|---|---|
| Provider | Hetzner Cloud, project `edtp-demo` |
| Server | `edtp-demo`, `cx23` (2 vCPU, 4 GB), `fsn1`, Ubuntu 24.04 LTS |
| Operator | user `edtp`, key-only SSH; key in `~/.edtp/demo-vm/` (never committed) |
| Inbound | **none**, once bootstrapped. Everything, SSH included, comes through the VM's own Cloudflare tunnel |

## Steps

1. `EDTP_BOOTSTRAP_IP=<your public IPv4> ./create-server.sh` creates the key, a firewall open only to
   SSH from that one address, and the server. `cloud-init.yaml` hardens the server and installs Docker
   and `cloudflared`, which is installed but not started. **Done 24 September 2026.**
2. **A person** creates the VM's own tunnel, `edtp-demo` (separate from the laptop's `edtp-dev`), and
   the route `edtp-ssh.murcata.es`. The credential is copied to `/etc/cloudflared/` on the VM, root-only;
   it never goes through this repository or cloud-init. The config and the systemd unit are in `files/`.
   (`cloudflared service install` did not create a unit from a config file here, so the unit is ours.)
   **Done 24 September 2026**: 4 connections, `fra` and `prg`.
3. SSH through the tunnel behind Cloudflare Access (application `EDTP demo SSH`, one-time PIN, the
   operator's e-mail only). Then `./close-bootstrap-ssh.sh` leaves the firewall with no inbound rules.
   **Done 24 September 2026**: the public port 22 is closed. SSH works only this way:
   `ssh -F ~/.edtp/demo-vm/ssh_config edtp-demo` (the config lives outside the repository). The first
   connection of a session asks for an Access login in the browser.
4. Deploy the stack. **Every deployment is confirmed by the user first** (ADR 0010). The first
   deployment, on 24 September 2026, **migrated the laptop's state** (decided: option A). Both databases
   were dumped and restored, the configuration was carried over with the public URLs, and so were the
   TEST CAs. That keeps every issued credential, key, trust list and policy. It is also the one
   deviation from ADR 0010 §3.3: these secrets were not generated on the VM; they are rotated when the
   VM is rebuilt. `registration/` (`hash_pid`, the PKCS#12) was **not** copied; the console mounts an
   empty one. The stack runs as
   `docker compose -f docker-compose.yml -f infra/demo-vm/docker-compose.demo.yml up -d`, with
   `EDTP_IMAGE` pinned to a `demo-image` build. `./negative-checks.sh --local` checks it before any name
   moves, and `./negative-checks.sh` checks it publicly after.
5. Move the `murcata.es` hostnames from `edtp-dev` to `edtp-demo`.

## Deploying: the `deploy-demo` workflow

`.github/workflows/deploy-demo.yml`, run on demand with one input: the 12-hex commit tag of a
`demo-image` build. A moving tag such as `main` is refused.

1. **Approval.** The run waits on the GitHub environment `demo`, whose required reviewer is the
   repository owner, and which only admits `main`. Anyone can request a deployment, Claude included;
   nothing proceeds unapproved.
2. **Access.** The runner reaches `edtp-ssh.murcata.es` through the VM's tunnel with a Cloudflare Access
   **service token**. The SSH application's policy includes a *Service Auth* rule for that token.
   `cloudflared` is pinned to 2026.9.1 and checked against its SHA-256.
3. **The key.** The deploy key's `authorized_keys` entry forces `deploy.sh`, with no port, agent or X11
   forwarding and no pty. The host key is pinned (`DEMO_KNOWN_HOSTS`, alias `edtp-demo-vm`).
4. **On the VM.** `deploy.sh` does the following:
   - pulls `main` and the image;
   - switches `EDTP_IMAGE` and waits for `platform-api` to become healthy;
   - runs the negative checks on loopback;
   - **if they fail, rolls back** to the previous image and alerts. If the rollback fails too, it stops
     the tunnel.

   Every deployment is appended to `/var/lib/edtp-status/deploys.log`.

The environment secrets are `DEMO_DEPLOY_KEY`, `DEMO_KNOWN_HOSTS`, `CF_ACCESS_CLIENT_ID` and
`CF_ACCESS_CLIENT_SECRET`. The deploy key and its known_hosts line are kept locally in
`~/.edtp/demo-vm/`, never here.

    gh workflow run deploy-demo -f tag=<12-hex>      # then approve it in GitHub

## The portal and the age check

`demo.murcata.es` (`apps/demo-portal`) shows one card per demonstration, with a status dot and a QR of
the page's address. It holds no secret. `/operador` is behind Cloudflare Access.

Tienda Demo's age check lives in the bank's process at `/edad`, so no further public process holds the
hosted-verifier secret. Its policy, "Comprobación de mayoría de edad (demo)", was created on the VM by
`scripts/register-age-check.mjs`. It requests `birthdate` and returns only `over_18`. It has to be
listed in both `HOSTED_VERIFIER_POLICIES` and `DEMO_BANK_POLICIES` (`edad=<id>`).

Fibra Demo's large-family discount lives there too, at `/fibra`, on the same terms. Its policy comes
from `scripts/register-large-family.mjs presentation` and is listed as `fibra=<id>`. The title it
verifies is issued by `fam-1`, "Comunidad Autónoma Demo", set up on the VM with
`scripts/create-engine-tenant.sh fam-1` and `scripts/setup-large-family-issuer.sh`
(`docs/credential-catalogue.md`, *The Large Family Title*).

**The VM's `.env` sets `EDTP_FORM_TENANTS` explicitly**, which overrides the compose default: it must
list `fam-1` too (`pid-1,rpi-1,fam-1`), or the gateway lets the wallet past the form, the person is
never identified, and the engine's request for the title's values gets a `404` — failing closed, with
nothing issued. That is what happened on the first attempt, on 28 September 2026.

## Banco Horizonte, the bank onboarding demonstration (ADR 0012)

`apps/demo-onboarding`, on `edtp-horizonte.murcata.es` (port 3205). It starts with every deployment and,
until it is configured, plays a recording under a banner that says so. To make it real, once, on the VM
— each step needs the operator, and the deployment that follows needs the user's approval:

1. **The Relying Party.** `PLATFORM_TENANT_API_KEY=… node scripts/register-bank-onboarding.mjs relying-party`
   prints the service id.
2. **Its engine tenant and access certificate.** `./scripts/create-engine-tenant.sh horizonte-1 "Banco
   Horizonte"`; a leaf under the development Access CA with the engine's public hostname as its SAN
   (`EDTP_LEAF_NAME=horizonte EDTP_LEAF_SUBJECT="/CN=Banco Horizonte - TEST/O=Banco Horizonte S.A.
   (ficticio)/C=ES" ./scripts/make-dev-access-ca.sh edtp-engine.murcata.es`, where the CA's key is);
   then `./scripts/import-access-certificate.sh <serviceId> horizonte-1 <horizonte.p12>`. Recreate
   `platform-api` so it reads the new tenant's credentials.
3. **The PID trust list on the new tenant**, under the id `ENGINE_ISSUER_TRUST_LISTS` already maps:
   `node scripts/load-issuer-trust-list.mjs --tenant horizonte-1 --lote <PIDProviders.jwt URL>
   --signer-sha256 <pin> --id edtp-test-pid-providers`. Without it every presentation fails as
   `trust_list_unavailable`.
4. **The policy.** `node scripts/register-bank-onboarding.mjs policy <serviceId> <PIDProviders.jwt URL>`
   prints the four `.env` lines: `HOSTED_VERIFIER_POLICIES` (append), `HOSTED_VERIFIER_ORIGINS`,
   `HOSTED_VERIFIER_QR_POLICIES` and `ONBOARDING_POLICY`.
5. **The hostname.** Route `edtp-horizonte.murcata.es` to the tunnel and install
   `files/cloudflared-config.yml`. Run `negative-checks.sh` with `EDTP_CHECK_ONBOARDING=1`.
6. **The card.** `PORTAL_SHOW_ONBOARDING=true` in `.env`.

### The loan's income certificate

Banco Horizonte's loan decides on a typed income until this is set up, and says so. With it, the loan
asks for a second presentation: an income certificate from "Nóminas Demo", a fictitious payroll
provider (`docs/credential-catalogue.md`). Each step needs the operator:

1. **The issuer.** `./scripts/create-engine-tenant.sh nominas-1 "Nominas Demo"`, recreate
   `platform-api`, then `PLATFORM_TENANT_API_KEY=… ./scripts/setup-income-issuer.sh`. It prints the
   provider id and saves the signing certificate as `~/.edtp/eaa-provider/nominas-1.crt`.
2. **The TEST list of EAA providers**, with a third anchor: `node scripts/make-test-lote.mjs --kind eaa
   --ca <the two already listed>,~/.edtp/eaa-provider/nominas-1.crt …`, published on `gh-pages`, then
   loaded on **`horizonte-1`**, the tenant that verifies it:
   `node scripts/load-issuer-trust-list.mjs --tenant horizonte-1 --lote <EAAProviders.jwt URL>
   --signer-sha256 <pin> --id edtp-test-eaa-providers`.
3. **Issuance.** `EDTP_ATTESTATION_DEFINITION=scripts/income/income-certificate.json node
   scripts/register-large-family.mjs issuance <providerId> <identifyPolicyId>`, then the printed entry
   in `HOSTED_FORM_POLICIES` and `POST …/issuance-policies/<id>/provision`. In `.env`: `nominas-1`
   in **`EDTP_FORM_TENANTS`**, `nominas-1=nominas` in `HOSTED_FORM_BRANDS`, and
   `nominas-1=Nóminas Demo` in `ENGINE_ISSUER_DISPLAY_NAMES`.
4. **Verification.** The same script with `presentation <Banco Horizonte's serviceId>
   <EAAProviders.jwt URL>`. The printed policy goes in `HOSTED_VERIFIER_POLICIES`,
   `HOSTED_VERIFIER_ORIGINS` and `HOSTED_VERIFIER_QR_POLICIES`, as the onboarding policy is, and in
   **`ONBOARDING_INCOME_POLICY`**.
5. **The wallet.** A build whose list offers the fourth issuer, `…/issuers/nominas-1` (W9).

### The back office

`https://edtp-horizonte.murcata.es/backoffice` shows the bank's fictitious staff the applications that
came in: the verified PID data, the verified income, and how the page says each ended. **It is the one
place this page keeps what a wallet presented** — in memory, twenty cases at most, half an hour each,
gone at a restart — so it is off by default and opened in this order, never another:

1. **A person** creates a Cloudflare Access application for `edtp-horizonte.murcata.es/backoffice`,
   with the operator-only policy, as `EDTP demo operador` is for the portal.
2. **Check it from outside, logged out:** the path must answer with Access's login redirect, not with
   the page's `404`. Until it does, do not go on.
3. `ONBOARDING_BACKOFFICE=on` in `.env`, and recreate `demo-onboarding`.

The page trusts the identity header Access injects, as the portal's `/operador` does. That means
something only because no request reaches the process except through the tunnel and, on that path,
through Access: with the switch on and no Access application, anyone could send the header. The
negative checks do not probe the path: behind Access it answers a redirect, which they would read as an
exposure.

**The test PID must carry the four address claims** the policy asks for (street, postal code, locality,
country): they are optional in the Rulebook, and a wallet whose PID lacks one reports that it holds
nothing suitable. Issue the demonstration's person, and a spare, from the hosted form with all four.

## The age verification demos (ADR 0011)

Lumen and Plaza, from the `age_verification_platform` repository, with that repository's verifier, run
as the compose project `av-demos` (`av/docker-compose.yml`). They are published on `av-lumen`, `av-plaza`
and `av-verifier.murcata.es`, and of the verifier only the three paths a wallet calls. They prefer
OpenID4VP, because the demo app on iOS cannot rely on the DC API.

`age_verification_platform` is a **private** repository, so the VM neither clones it nor pulls its images
anonymously. Once, on the VM:

1. **A person** logs Docker in to ghcr with a classic token whose only scope is `read:packages`
   (fine-grained tokens do not work with ghcr), typed on the VM so it never passes anywhere else:
   `docker login ghcr.io -u <user>`. It is stored in `~/.docker/config.json`, mode 600.
2. Copy that repository's PKI generator and the public certificates it pins, and the issuer machine's
   trust store (certificates only; the script refuses a store with a private key):
   `scp -r <checkout>/pki/generate-test-pki.sh <checkout>/pki/trust edtp-demo:.av/pki-tools/` and
   `scp <checkout>/pki/out/trusted-issuers.p12 edtp-demo:/tmp/`. Then run
   `infra/demo-vm/av/setup-pki.sh /tmp/trusted-issuers.p12`. It asks for that store's password,
   generates the verifier's TEST PKI for `av-verifier.murcata.es` in `~/.av/pki`, and writes
   `~/.av/demos.env` with random keys and secrets.
3. **A person** adds the three routes to the `edtp-demo` tunnel, then installs the new
   `files/cloudflared-config.yml` as `/etc/cloudflared/config.yml` and restarts `cloudflared`.
4. Deploy with `gh workflow run deploy-demo -f stack=av -f tag=<12-hex>`, the tag from
   `age_verification_platform`'s `demo-images` workflow, and approve it. Then run
   `EDTP_CHECK_AV=1 ./negative-checks.sh` publicly.
5. Set `PORTAL_SHOW_AV_DEMOS=true` in the VM's `.env` and recreate `demo-portal`.

The nightly reset recreates Lumen and Plaza. Their deployments are logged as `av <tag>` in
`/var/lib/edtp-status/deploys.log`.

## Scheduled checks and the nightly reset (ADR 0010 §3)

systemd timers, whose units are in `files/`:

| Timer | What |
|---|---|
| `edtp-negative-checks` | Every 15 minutes, `scheduled-checks.sh`: the public negative checks. **An exposure (a forbidden path answering other than 404) stops the tunnel**, taking every demo hostname offline until a person has looked. An unreachable host only alerts. The last result is in `/var/lib/edtp-status/checks.json`, shown on the portal's `/operador` |
| `edtp-nightly` | 03:30 Europe/Madrid, `nightly-reset.sh`: back to the `generic` profile, application containers recreated (never the databases or the engine, whose status lists issued credentials depend on), old images pruned, then the checks |

Alerts go to the journal (`journalctl -t edtp-checks`). If `~/.edtp/alerts.env` sets `ALERT_WEBHOOK_URL`,
they are also POSTed there, for example to a push-notification topic. The message carries no path,
address or secret.
**Configured on 24 September 2026: a private ntfy.sh topic.** Its name is random, and is kept only in
`~/.edtp/alerts.env` on the VM and in `~/.edtp/ntfy-topic` on the operator's machine, never here: anyone
who knows it can read the alerts. Exposures are sent as `urgent`; unreachable hosts and a failed nightly
reset as `high`.

**After a stop, SSH is gone too**, because it runs through the same tunnel. To get back in:
- reopen port 22 to your address alone, with `EDTP_BOOTSTRAP_IP=<your IPv4> ./create-server.sh`, which
  reuses what exists and only resets the firewall rule;
- or use Hetzner's web console.

Find the cause and fix it. Then run `sudo systemctl start cloudflared`, run the checks by hand, and close
port 22 again with `./close-bootstrap-ssh.sh`.

Installed on 24 September 2026. The first scheduled run and a manual nightly run both passed (32 of 32
are `404`).

**Incident on 24 September 2026, 18:05 UTC.** The first `deploy-demo` run succeeded, but a scheduled
check ran at the same time as the containers were restarting. It read their 502s as exposure and stopped
the tunnel. The fail-closed stop worked as designed; the classification was wrong. Fixed as follows:
- only a real answer counts as exposure (2xx, 3xx, 4xx other than 404); a 5xx (including Cloudflare's
  530), a 429 or no connection counts as unreachable;
- an exposure is re-checked 30 seconds later before the tunnel is stopped;
- scheduled checks skip their turn while `deploy.sh` holds `/tmp/edtp-deploy.lock`.

Recovery followed the procedure above: port 22 was reopened to one address, the local checks passed,
the tunnel was started, the public checks passed, and port 22 was closed again. The demo was down for
about 25 minutes.

## Branding profiles (ADR 0010 §2)

`profiles/generic.env` is the public default. `profiles/fnmt-corpme.env` and `profiles/gobcan.env` are
client profiles; switch one on only with the organisation's written permission. `gobcan` (28 September
2026) brands only the Large Family Title's issuer, `fam-1`, as "Gobierno de Canarias (demo)", with a
look taken from the public sede's stylesheet and **no emblem**; the PID issuer and the register keep
their generic names. The title's content stays neutral: its `issuing_authority` is the fictitious
"Consejería de Familia (demo)", whichever profile is on. On the VM:

    ~/edtp/implementation/infra/demo-vm/demo-profile.sh fnmt-corpme   # reverts by itself after 4 hours
    ~/edtp/implementation/infra/demo-vm/demo-profile.sh generic       # back now
    journalctl -t edtp-profile                                        # who switched what, when

**Or from the portal:** `https://demo.murcata.es/operador` has a switch. The portal does not switch
anything itself; it has no access to Docker or the host. It writes `request.json` into
`/var/lib/edtp-profile-requests`, the only directory it can write to. The systemd path unit
`edtp-profile-request` then runs `apply-profile-request.sh`, which validates the request again (a profile
in `profiles/`, a requester that looks like an e-mail address) and calls `demo-profile.sh`. The requester
is the Cloudflare Access identity, recorded in the journal. A client profile needs the "written
permission" box ticked. A submission must come from the portal's own page (`Sec-Fetch-Site` or
`Origin`), so another site cannot submit it in the operator's name.

A client's look is served only on `edtp-cliente.murcata.es`, which sits behind Cloudflare Access. The
form shows the neutral brand on every other host (`selectBrand`, `tests/unit/form-brands.test.ts`). The
client emblems are served only while a client profile is on. The PID's content stays neutral in both
profiles (`issuing_authority`, the type's label): a profile changes presentation, not what is attested.

The VM's checkout (`~/edtp`) tracks **`main`** since PR #6 was merged (24 September 2026). Deploying
still means pinning `EDTP_IMAGE` to a `demo-image` build, and it is always confirmed by the user.

Secrets for the stack are generated on the VM and stay there, except the migrated ones (step 4).
