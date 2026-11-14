# Sandbox VM

The EUDI ecosystem sandbox's own VM ([ADR 0017](../../docs/adr/0017-sandbox-vm.md)), built like the
demonstration VM ([`../demo-vm/`](../demo-vm/README.md), ADR 0010).

| | |
|---|---|
| Provider | Hetzner Cloud |
| Server | `edtp-sandbox`, `cx23` (2 vCPU, 4 GB), `fsn1`, Ubuntu 24.04 LTS. Hetzner daily backups on; the nightly dump timer is installed but **not enabled** until the user says (13 November 2026) |
| Operator | user `edtp`, key-only SSH; key in `~/.edtp/sandbox-vm/` (never committed) |
| Inbound | **none**, once bootstrapped. Everything, SSH included, comes through the VM's own tunnel `edtp-sandbox` |
| Hostnames | `sandbox.murcata.es` (portal, behind Access), `sandbox-engine.murcata.es`, `sandbox-platform.murcata.es` (both through the gateway), `sandbox-ssh.murcata.es` (Access, operator only) |

**State, 13 November 2026: steps 1–8 done** — the server, the tunnel and its DNS, both Access
applications, SSH through the tunnel with the public port closed, the checkout, `.env`, the trust
domain and the sign-in verifier. **Nothing is deployed:** no container runs. Each step that touches the VM, Cloudflare or GitHub is done by
a person, or by Claude only once the user has confirmed it. **Every deployment is confirmed by the
user first.**

| File | What it is |
|---|---|
| `docker-compose.sandbox.yml` | The whole stack: two databases, the engine, the platform, the portal, the gateway. Loopback ports only |
| `files/cloudflared-config.yml` | The tunnel's ingress: SSH, the gateway's two ports, the portal; a `404` for anything else |
| `sandbox.env.example` | The VM's `.env`, without secrets |
| `generate-secrets.sh` | Fresh secrets, generated on the VM; refuses to replace existing ones |
| `negative-checks.sh` | Every forbidden path is a `404`, and the portal is locked |
| `scheduled-checks.sh`, `files/edtp-sandbox-checks.*` | The checks every 15 minutes; an exposure stops the tunnel |
| `nightly-backup.sh`, `files/edtp-sandbox-backup.*` | Both databases and the sealed key store, nightly and before each deployment, 14 kept |
| `deploy.sh` | The deploy key's only command: backup, switch, health, checks, rollback |
| `../../../.github/workflows/deploy-sandbox.yml` | The workflow that calls it, after the user's approval |

## A tools container, because the host has no Node

The helper scripts need `bash`, `openssl`, `jq`, `curl` and `node`. The host has the first four, but not
Node, and the platform image is Alpine. Run the scripts in a throwaway container on the host network,
from `~/edtp/implementation`:

```bash
tools() { docker run --rm -i --network host -v "$PWD:/w" -w /w -e PLATFORM_TENANT_API_KEY -e TENANT_ID \
  -e P12_PASSWORD node:22.23.2-alpine sh -c 'apk add -q bash openssl jq curl >/dev/null && "$@"' sh "$@"; }
```

The PKI commands run from the platform image, whose `packages/sandbox-pki/dist/cli.js` needs no
configuration but the key:

```bash
pki() { docker run --rm -i -v /var/lib/edtp-sandbox/pki:/pki -v "$PWD/work:/work" -e SANDBOX_KEYSTORE_KEY \
  "$(sed -n 's/^EDTP_IMAGE=//p' .env)" node packages/sandbox-pki/dist/cli.js "$@" --dir /pki; }
```

## Steps

1. **The server.** From the laptop:
   ```bash
   EDTP_DEMO_VM_NAME=edtp-sandbox EDTP_DEMO_VM_KEY_DIR=~/.edtp/sandbox-vm EDTP_VM_ROLE=sandbox \
     EDTP_VM_BACKUPS=1 EDTP_BOOTSTRAP_IP=<your IPv4> ./infra/demo-vm/create-server.sh
   ```
   It is the demonstration VM's script and `cloud-init.yaml`, with this VM's name and role. Daily
   Hetzner backups are on.

2. **The tunnel** (a person, with the Cloudflare credential):
   - create the tunnel: `cloudflared tunnel create edtp-sandbox`;
   - route the four hostnames **by the tunnel's id, with the laptop's own config out of the way**:
     `cloudflared --config <an empty file> tunnel route dns --overwrite-dns <tunnel id> <host>`. A
     `tunnel:` line in `~/.cloudflared/config.yml` silently wins over the name on the command line,
     and the routes land on that other tunnel (it happened on the first set-up: check the
     `tunnelID=` each line prints);
   - copy the credential to `/etc/cloudflared/` on the VM, root-only;
   - install `files/cloudflared-config.yml` as `/etc/cloudflared/config.yml`, with `__TUNNEL_ID__`
     replaced and **without the portal rule and the SSH rule** for now: each is added only once its
     Access application is seen protecting the hostname;
   - install `../demo-vm/files/cloudflared.service` and start it.

3. **Access applications** (a person, in Cloudflare Zero Trust):
   - **`EDTP sandbox SSH`** on `sandbox-ssh.murcata.es`:
     - one-time PIN, the operator's e-mail only;
     - plus a *Service Auth* rule for the deploy service token.
   - **`EDTP sandbox portal`** on `sandbox.murcata.es`, the whole hostname:
     - one-time PIN;
     - a policy listing the invited participants' e-mail addresses (ADR 0017 §2).

   **Check it from outside, logged out.** `curl -sI https://sandbox.murcata.es/` and
   `curl -sI https://sandbox-ssh.murcata.es/` must each redirect to `*.cloudflareaccess.com`. Only
   then add the two rules to the tunnel's config and reload. Until then, do not go on.

4. **SSH through the tunnel.** Write `~/.edtp/sandbox-vm/ssh_config` (the demonstration VM's, with this
   VM's names). Then run
   `EDTP_DEMO_VM_NAME=edtp-sandbox ./infra/demo-vm/close-bootstrap-ssh.sh` from the laptop. The public
   port 22 closes.

5. **The checkout and the directories**, on the VM:
   ```bash
   git clone https://github.com/ssanchocanela/european-digital-trust-platform.git ~/edtp
   sudo install -d -m 700 -o 1000 -g 1000 /var/lib/edtp-sandbox/pki
   sudo install -d -m 755 -o 1000 -g 1000 /var/lib/edtp-sandbox/wallet
   sudo install -d -m 755 /var/lib/edtp-status
   ```
   UID 1000 is the image's `node` user, which writes hosted issuers' keys to the store.

6. **`.env`**, on the VM, in `~/edtp/implementation`:
   ```bash
   cp infra/sandbox-vm/sandbox.env.example .env && infra/sandbox-vm/generate-secrets.sh >> .env && chmod 600 .env
   ```
   - Set `EDTP_IMAGE` to the tag the user has confirmed.
   - `ENGINE_CLIENT_ID=root` is in the template: `create-engine-tenant.sh` reads it, and it is not a
     secret (the engine's root client id).
   - **Copy `SANDBOX_KEYSTORE_KEY` into the operator's password manager now.** It is in no backup.

7. **The trust domain**, fresh: the first deployment is not a migration of the laptop's.
   - Initialise it:
     ```bash
     export SANDBOX_KEYSTORE_KEY="$(sed -n 's/^SANDBOX_KEYSTORE_KEY=//p' .env)"; mkdir -p work; pki init
     ```
   - Place the **sign-in anchors** in `/var/lib/edtp-sandbox/pki/pid-sign-in-anchors/*.pem`:
     - the seven reference PID Provider anchors, from the notified development `PIDProviders` list;
     - the development PID CA's **certificate** (`~/.edtp/dev-pid-ca/ca.crt`), for "PID (demo)". Never
       its key.
   - Place the **Wallet Provider anchors** in `wallet-provider-anchors/*.pem`, as in the S4 and S5 run
     sheets.

8. **The sign-in verifier** (ADR 0015). It is the operator's own Relying Party Instance; it must exist
   before the sandbox can start.
   1. Start the engine. Compose checks every required variable even for one service, and
      `ENGINE_TENANT_CREDENTIALS` cannot exist before the tenant does, so give it a placeholder **in the
      shell only**:
      `ENGINE_TENANT_CREDENTIALS=not-yet docker compose -f infra/sandbox-vm/docker-compose.sandbox.yml --env-file .env up -d eudiplo`.
      Then create the engine tenant: `./scripts/create-engine-tenant.sh sbx-operator "EDTP Sandbox sign-in"`.
   2. **Start the platform once without the sandbox**, which cannot start before its operator exists:
      ```bash
      docker compose -f infra/sandbox-vm/docker-compose.sandbox.yml --env-file .env run -d --rm --name sbx-bootstrap \
        --service-ports -e SANDBOX_PORTAL_SECRET= -e SANDBOX_PKI_DIR= -e SANDBOX_KEYSTORE_KEY= \
        -e SANDBOX_PUBLIC_BASE_URL= -e SANDBOX_PARTICIPANT_TRUST_SOURCES= platform-api
      ```
   3. Create the operator's tenant with the admin key: `POST /v1/tenants` with
      `{"name":"EDTP Sandbox operator"}`. **The key is shown once and only its hash is kept; there is
      no rotation.** Write it to `work/operator-tenant.key` (mode 600) and copy it into the operator's
      password manager before going on; it is shredded with `work/` in 8.7. Not `/dev/shm`: logind
      removes a user's files there when the last SSH session closes (`RemoveIPC=yes`), which lost the
      first key. A shell variable does not outlive one SSH session either. Then:
      `tools node scripts/register-sandbox-operator.mjs relying-party`.
   4. **The access certificate, from the sandbox Access CA.** A sandbox wallet build trusts no other.
      - Make a key and a request in `work/` with `tools openssl …`.
      - Issue the certificate:
        `pki issue-access --csr /work/req.pem --dns sandbox-engine.murcata.es --public-base https://sandbox-platform.murcata.es/sandbox/public --legal-name "EDTP Sandbox operator" --trade-name "EDTP Sandbox sign-in" --country EU --identifier SB:EU-000000 --service SIGNIN --support https://sandbox.murcata.es --out /work/operator-wrpac.pem`.
      - **Chain-check it against the sandbox Access CA** before any wallet use (`openssl verify`).
      - Make a PKCS#12 of the key and the chain.
      - Import it: `TENANT_ID=… tools bash scripts/import-access-certificate.sh <serviceId> sbx-operator work/operator.p12`.
   5. Load the sign-in PID list on the tenant:
      `tools node scripts/load-issuer-trust-list.mjs --tenant sbx-operator --lote https://ssanchocanela.github.io/european-digital-trust-platform/lote/PIDProviders.jwt --signer-sha256 <pin> --id edtp-test-pid-providers`.
      Then put `<that URL>=edtp-test-pid-providers` in `ENGINE_ISSUER_TRUST_LISTS`.
      - **The pin** is `XZYljt8vK9Ldji4UpKuwskcdW-sXijPos1OT5Tl1SCw`, the SHA-256 of
        `~/.edtp/dev-access-ca/lote-signer.crt`. Check it against that file on the laptop, not only
        against the list.
      - **The engine needs a `trustList` key** to re-sign the copy it holds. By default the script
        imports the laptop's list signer key from `~/.edtp/dev-access-ca`. **Do not bring that key to
        the VM**: it signs the published TEST lists. Make a fresh self-signed P-256 key and certificate
        in `work/engine-list-key/lote-signer.{key,crt}` and pass `--ca-dir /w/work/engine-list-key`, as
        the sandbox does for its runtime tenants ("EDTP Sandbox engine list key").
      - **The list's `NextUpdate` is 22 December 2026.** Republish it and re-run this command before
        then, or sign-in fails closed.
   6. Create the policy:
      `tools node scripts/register-sandbox-operator.mjs policy <serviceId> <that URL> https://sandbox-platform.murcata.es/sandbox/public/lote/PIDProviders.jwt`.
      Put the two printed lines in `.env`.
   7. `docker stop sbx-bootstrap`, then shred `work/`: it held the keys. The operator's access
      certificate is valid for 90 days (the first one, until 11 February 2027): reissue it by 4.

9. **The stack**, once the user has confirmed the deployment:
   - start it: `docker compose -f infra/sandbox-vm/docker-compose.sandbox.yml --env-file .env up -d`;
   - set `ENGINE_DB_SYNCHRONIZE=false` in `.env`, and recreate the engine.

   Then check:
   - `infra/sandbox-vm/negative-checks.sh --local` must pass;
   - then `infra/sandbox-vm/negative-checks.sh` from outside;
   - `https://sandbox-platform.murcata.es/sandbox/public/lote/WRPACProviders.jwt` must answer.

10. **Timers.** Install the four units from `files/` in `/etc/systemd/system/`. Then run
    `systemctl enable --now edtp-sandbox-checks.timer edtp-sandbox-backup.timer`. Run
    `infra/sandbox-vm/nightly-backup.sh` once by hand and look at what it wrote.

11. **Deploying from GitHub** (a person):
    - create the GitHub environment `sandbox`:
      - the repository owner as its required reviewer;
      - `main` only;
      - the secrets `SANDBOX_DEPLOY_KEY`, `SANDBOX_KNOWN_HOSTS`, `CF_ACCESS_CLIENT_ID` and
        `CF_ACCESS_CLIENT_SECRET`;
    - add the deploy key to `~edtp/.ssh/authorized_keys`, forced to the deploy script:
      `command="/home/edtp/edtp/implementation/infra/sandbox-vm/deploy.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty`.

    Then:
    ```bash
    gh workflow run deploy-sandbox -f tag=<12-hex>      # then approve it in GitHub
    ```

12. **The wallet build**, only after legal confirmation of the EUPL reading (ADR 0010 §4).
    - Copy the release APK and its notice into `/var/lib/edtp-sandbox/wallet/`. The notice is
      `tools/test-wallet/DELIVERY-NOTICE.md`, filled in for that build, as `.txt`.
    - Write `wallet.json` there, in the form `apps/sandbox-portal/src/wallet.ts` documents, with
      `legalConfirmed` set. The portal lists the build only if its SHA-256 matches and it is a release
      build.

## Operating

- **Participants:**
  `docker compose -f infra/sandbox-vm/docker-compose.sandbox.yml --env-file .env exec platform-api node apps/platform-api/dist/sandbox-operator-cli.js participants`.
- **Suspend one:** the same, with `suspend SB:ES-000001 --reason "<why, no personal data>"`. It revokes
  every certificate the organisation holds, at once, and it is final.
- **Invite someone:** add their e-mail to the `EDTP sandbox portal` Access policy. **Remove someone:**
  take it out, then suspend their organisations if needed.
- **A full reset** is never scheduled (ADR 0017 §4). If one is needed, the operator does it by hand,
  with notice to the participants: new secrets, an empty `pki/`, empty volumes, then step 7 onwards.
  Every sandbox wallet build stops trusting the old domain.
- **Restoring:** each backup directory holds `platform.dump`, `engine.dump`, `pki.tar` and
  `SHA256SUMS`. Restore with `pg_restore --clean` into the stopped stack's databases and untar `pki/`.
  Opening the keys takes the `SANDBOX_KEYSTORE_KEY` from the password manager.
