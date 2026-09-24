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

Secrets for the stack are generated on the VM and stay there.
