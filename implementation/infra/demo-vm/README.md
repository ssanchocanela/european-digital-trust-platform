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

## The portal and the age check

`demo.murcata.es` (`apps/demo-portal`) shows one card per demonstration, with a status dot and a QR of
the page's address. It holds no secret. `/operador` is behind Cloudflare Access.

Tienda Demo's age check lives in the bank's process at `/edad`, so no further public process holds the
hosted-verifier secret. Its policy, "Comprobación de mayoría de edad (demo)", was created on the VM by
`scripts/register-age-check.mjs`. It requests `birthdate` and returns only `over_18`. It has to be
listed in both `HOSTED_VERIFIER_POLICIES` and `DEMO_BANK_POLICIES` (`edad=<id>`).

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

## Branding profiles (ADR 0010 §2)

`profiles/generic.env` is the public default. `profiles/fnmt-corpme.env` is a client profile; switch it
on only with the organisations' written permission. On the VM:

    ~/edtp/implementation/infra/demo-vm/demo-profile.sh fnmt-corpme   # reverts by itself after 4 hours
    ~/edtp/implementation/infra/demo-vm/demo-profile.sh generic       # back now
    journalctl -t edtp-profile                                        # who switched what, when

A client's look is served only on `edtp-cliente.murcata.es`, which sits behind Cloudflare Access. The
form shows the neutral brand on every other host (`selectBrand`, `tests/unit/form-brands.test.ts`). The
client emblems are served only while a client profile is on. The PID's content stays neutral in both
profiles (`issuing_authority`, the type's label): a profile changes presentation, not what is attested.

Secrets for the stack are generated on the VM and stay there, except the migrated ones (step 4).
