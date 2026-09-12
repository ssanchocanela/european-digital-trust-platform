# Development setup, and moving between machines

Prerequisites per platform, and what to do when the work moves to a different computer.

The short version of moving: **clone, do not copy.** Everything that matters is in git; everything else
is either regenerable in minutes or a secret that should not travel.

---

## 1. What moves, and how

| | | |
|---|---|---|
| Source, scripts, docs, patches | **`git clone`** | ~10 MB. This is the whole product |
| `node_modules` | `pnpm install` | 506 MB, platform-specific binaries. **Never copy it** — `embedded-postgres` and `esbuild` resolve per-platform optional dependencies, and a macOS tree in a Linux container fails with `ERR_PNPM_IGNORED_BUILDS` |
| The wallet's upstream clone | `tools/test-wallet/build.sh` | 3.2 GB, gitignored, pinned by commit. Re-cloning is the *point*: the pin is what makes it reproducible |
| The built APK | `tools/test-wallet/build.sh` | 363 MB. Two builds from the same inputs are byte-identical, so rebuilding gives the same artefact |
| Docker volumes | `docker compose up` | Migrations run at startup; the seed data is synthetic and made by `smoke-vaas.sh` |
| The scratchpad toolchain | Reinstall | Node, `cloudflared`, JDK. All standard downloads |
| **`.env`** | **Re-create** | Secrets. See §4 |
| **The wallet signing keystore** | **Decide** | See §5 |
| **`sources/`** | **Do not move casually** | See the note below |

> **`sources/` holds internal reference material, including national comitology documents.** It is
> untracked and gitignored precisely so it never leaves the machine by accident. Whether a copy may sit
> on a personal computer is an employer question, not a technical one — and nothing in this repository
> needs it: every committed file cites the public instrument instead, which `check-confidentiality.mjs`
> enforces on every commit.

## 2. Prerequisites

| | Version | Needed for |
|---|---|---|
| Node | **22 LTS** (`>=22.0.0 <23`) | Everything. pnpm comes from corepack |
| Docker | Any current release | The engine, both databases, the platform image |
| `openssl`, `curl`, `jq` | Any | The scripts |
| JDK | **17** | The test wallet only |
| Android SDK | platform **37**, build-tools **37.0.0** | The test wallet only |
| `cloudflared` | Any current release | A test session with a phone only |

`pnpm verify` needs **none of the optional rows** and no Docker: the integration suite boots an embedded
PostgreSQL. That is the check to run first on a new machine, because it proves the toolchain without
proving anything about Docker.

## 3. Windows

**Use WSL2. Not native Windows, and not a virtual machine.**

This is not a stylistic preference. The scripts are bash and call `openssl`, `curl` and `jq`; the paths
are POSIX; `docker compose` on Windows runs on WSL2 anyway. Running natively means rewriting the scripts
for PowerShell and maintaining two versions of each — and a full VM gives you WSL2's isolation with none
of its integration.

```powershell
wsl --install -d Ubuntu        # then reboot
```

Then, inside Ubuntu:

```bash
sudo apt update && sudo apt install -y curl git jq openssl unzip
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
corepack enable pnpm
```

Docker Desktop for Windows: install it, then **Settings → Resources → WSL integration → enable for
Ubuntu**. `docker` then works from inside WSL and the compose file needs no changes.

### The one mistake that costs a day

**Keep the repository in the WSL filesystem — `~/projects/…` — never under `/mnt/c/…`.**

Files on `/mnt/c` cross a translation layer on every operation. `pnpm install` goes from under a minute
to many, `git status` crawls, and file watching silently stops working. The symptom is not an error; it
is everything being inexplicably slow, which is much harder to diagnose than a failure.

To reach the files from Windows — an editor, Explorer — use the other direction: `\\wsl$\Ubuntu\home\…`,
which is fast because the translation happens on the Windows side.

### A phone, from WSL

WSL2 has no USB passthrough by default, so `adb` inside WSL sees no device. Two options, and the first
is much simpler:

| | |
|---|---|
| **Use Windows' `adb.exe` from inside WSL** | Install Android platform-tools on **Windows**, then call it from WSL: `alias adb='/mnt/c/Users/<you>/AppData/Local/Android/Sdk/platform-tools/adb.exe'`. It works, including `logcat` |
| `usbipd-win` | Real USB passthrough into WSL. More setup, needed only if something requires a native Linux `adb` |

Build the APK **inside WSL** (the build script is bash, and Gradle is happiest on the Linux filesystem)
and talk to the phone with the Windows `adb.exe`. The APK path crosses over as
`/mnt/c/...` or via `\\wsl$`, either way.

### Two things that get *better* on a personal machine

- **No TLS interception.** A corporate proxy re-signs TLS, and the JDK does not trust its root even when
  the OS does — which is why `tools/test-wallet/README.md` documents `EDTP_JAVA_TRUSTSTORE`. On a
  network without interception that workaround is unnecessary: do not set it.
- **Tunnels are less likely to be blocked.** `cloudflared` needs outbound UDP 7844 (it falls back to
  HTTP/2), which corporate networks often restrict.

## 4. Re-creating `.env`

Never copy it between machines over chat, email or a shared drive. Start from the example and generate
fresh values:

```bash
cp .env.example .env && chmod 600 .env
```

Then fill every `CHANGE-ME`. The three web-interface secrets are generated, not chosen:

```bash
openssl rand -hex 24     # CONSOLE_OPERATOR_PASSWORD — the only one you ever type
openssl rand -hex 32     # CONSOLE_SESSION_SECRET
openssl rand -hex 32     # START_TOKEN_SECRET  — must differ from the one above
```

`CONSOLE_TENANT_API_KEY` is not a secret you invent: it is returned once by `POST /v1/tenants` and
stored only as a hash, so a new machine means a new tenant, or the same key carried across by hand.

A fresh tenant is **empty**, so the test driver has no policy to run. Give it one the same way the smoke
test does — `scripts/smoke-vaas.sh` builds the whole chain — or the console will start with nothing to
do.

## 5. The wallet signing keystore — a real decision

The keystore lives outside the repository and is not in git. Two choices, and they are not equivalent:

| | |
|---|---|
| **Carry it across** (encrypted, by hand) | The rebuilt APK keeps the same signing identity, so it **upgrades in place** on a phone that already has it |
| **Generate a new one** (`make-signing-key.sh`) | Simpler and safer. But Android refuses an update signed by a different key: `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, and the fix is `adb uninstall eu.europa.ec.euidi.edtptest`, which **deletes that wallet's data including any PID it holds** |

Generate a new one unless a phone is already carrying a PID you would rather not obtain again.

## 6. Claude Code on the new machine

Install it **inside WSL**, where the project lives, so it sees the same filesystem and the same tools.

Conversation history does not travel — sessions are local. That matters less than it sounds, and
deliberately so: `CLAUDE.md` carries the rules, `docs/` carries the findings and the open blockers, and
every non-obvious decision is written down at the point it was taken. Pointing a new session at
`implementation/CLAUDE.md` is the whole handover.

## 7. The order to do it in

```bash
git clone <this repository> && cd european-digital-trust-platform/implementation
cp .env.example .env && chmod 600 .env     # then fill it in — §4
pnpm install
pnpm verify                                # no Docker needed; proves the toolchain
docker compose up -d
PLATFORM_ADMIN_API_KEY=<yours> ./scripts/smoke-vaas.sh
```

If `pnpm verify` passes, the platform is sound and anything failing afterwards is Docker, configuration
or the network — which is a much smaller space to search. Run it before anything else.
