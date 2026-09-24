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
   places its credential on the VM. That credential never goes through this repository or cloud-init.
3. SSH through the tunnel behind Cloudflare Access. Then `./close-bootstrap-ssh.sh` leaves the firewall
   with no inbound rules.
4. Deploy the stack. **Every deployment is confirmed by the user first** (ADR 0010).
5. Move the `murcata.es` hostnames from `edtp-dev` to `edtp-demo`.

Secrets for the stack are generated on the VM and stay there.
