# Permanent demonstration environment — proposal

**Status: proposal, not built.** Written 24 September 2026. The choices in §10 are decided and recorded
in [ADR 0010](adr/0010-permanent-demonstration-environment.md), **ACCEPTED** on 24 September 2026. The
documents it changes are listed in §9.

Today every demonstration depends on one laptop. A Cloudflare tunnel is opened by hand for each test
session, the home router has to cooperate, and the stack stops existing when the laptop sleeps. This
document proposes an environment that is always on, and a portal page from which each demonstration can
be chosen.

Two decisions shape it. Both were taken on 24 September 2026:

1. **The public demonstrations are generic.** No real organisation's name, logo or colours appear on
   anything reachable without credentials: a neutral PID issuer, a neutral registry, and the already
   fictional *Banco Demo*.
2. **Client-branded demonstrations** — the FNMT-styled PID, the CORPME-styled representation credentials
   — are switched on only for a demonstration to that client, and only behind a **username and
   password**.

---

## 1. What changes, and what does not

| | Today (test sessions) | Proposed (permanent) |
|---|---|---|
| Where it runs | the developer's laptop | a small cloud VM in the EU |
| Public exposure | a tunnel opened by hand, closed after the session | a tunnel **run by the VM** as a system service, always on |
| Allow-list gateway | yes | **unchanged**: same rules, same default-deny, same negative checks |
| Engine Management API | never exposed | never exposed |
| Operator console | localhost only | private, behind an identity gate (§5) |
| Branding | whatever the session was configured for | **generic** by default; client branding is a profile switched on for one demonstration (§4) |
| Data | synthetic | synthetic, and **reset every night** |
| Wallet | the modified EDTP test wallet | the same; a release build downloadable behind the login (§7) |

Unchanged in substance: `TEST` only, synthetic data only, no production claims, and no claim of
conformance.

## 2. Hosting

**Recommended: one VM, Docker Compose, Cloudflare Tunnel on the VM.**

| | |
|---|---|
| Provider and region | **Hetzner Cloud**, Falkenstein or Nuremberg (decided 24 September 2026). The reason is that it can be operated entirely by API and CLI (`hcloud`), and it is a plain Docker host with no platform to adapt to. An EU region is not a legal necessity with synthetic data; it forms the habit (`test-session-vm.md` §2) |
| Size | **The smallest shared x86 plan with 2 vCPU and 4 GB RAM** ("Regular Performance"). Measured on 24 September 2026, the whole stack at rest uses **~340 MiB**: engine 168, platform 51, both Postgres 59, form, bank, console and start page 68. The OS, `cloudflared`, the gateway and the portal keep it under 1 GB, and CPU is near zero. Images are built in GitHub Actions, not on the VM. Resizable in place if it ever runs short. ARM plans are cheaper but need multi-arch builds; start with x86 |
| OS | Debian or Ubuntu LTS, with unattended security upgrades |
| Cost | Read from Hetzner's current price table when the server is created. An earlier estimate here was wrong, and was made before the stack was measured |
| Inbound | **No inbound ports.** `cloudflared` on the VM connects out, as the laptop does today, so the machine has no public listener to harden. SSH through Cloudflare Access or the provider's console only |
| TLS | Cloudflare's edge certificate, as today. The wallet needs an OS-trusted chain, and this is one |
| Hostnames | Kept on `murcata.es`, so attestations already issued keep a resolvable status list URI (the reason the named tunnel exists) |

This reuses nearly everything already built: the tunnel configuration, the allow-list gateway, the
compose file and the session scripts. It also removes the two failure modes of the last week: a
laptop that is off, and a home router that caches a new hostname as nonexistent.

### Deployments

The goal is that no deployment depends on a developer's laptop, and that every running version is a
known commit.

1. **Build.** On every merge to `main`, GitHub Actions builds the image and pushes it to the GitHub
   Container Registry. The registry is private.
2. **Deploy.** A manual workflow, `deploy-demo`, takes a commit or tag and does the following:
   - it connects to the VM over SSH **through the VM's own Cloudflare tunnel**, authenticated with a
     Cloudflare Access service token, so port 22 is never open to the internet;
   - it runs `docker compose pull && docker compose up -d`;
   - it runs the negative checks. **If any check is not `404`, it rolls back to the previous tag.**
3. **Rollback.** Re-run the workflow with an earlier tag.
4. **Who triggers it.** A person, or Claude through `gh workflow run deploy-demo`. A deployment is an
   outward-facing action. Whether a standing authorization covers deploying after each merge to `main`
   is still open (§10).

Out of the repository, set up by a person: the Hetzner account and a project API token, a Cloudflare
Access service token for the deploy workflow, and the repository secrets that hold both.

**Considered and not recommended:** managed container platforms (Azure Container Apps, Cloud Run, Fly.io).
The engine and the platform each need a Postgres with a stable schema, the engine bakes its public URL
into what it issues, and the services talk over a private network. None of that is hard on one VM, and
all of it is extra work on a managed platform, with no benefit a demonstration needs.

Also not recommended: keeping the laptop and running the tunnel permanently. It is the current setup
with the tunnel left open.

## 3. The demonstration portal

**Built and deployed on 24 September 2026** (image `4a74c71ba437`), at `https://demo.murcata.es`. The age check card uses Tienda Demo, `/edad` in the
bank's process. The profile switch stays an SSH command, shown on the operator page; it is not a portal
button.

A new small app, `apps/demo-portal`, at `demo.murcata.es`. It is server-rendered with no script, the same
pattern as `pid-form` and `demo-bank`.

**Public part: the generic demonstrations.** One card per demonstration:

| Card | What the visitor does |
|---|---|
| Get a test PID | In the wallet, *Add document → From list → "PID (demo)"*; a neutral form |
| Get a representation credential | From the same list, the neutral registry; identify with the PID, then request |
| Banco Demo | Authorise a fictitious company transfer by presenting a representation credential |
| Age check | Prove "over 18" derived from the PID's date of birth. The date itself is never returned (ADR 0005 Decision 5) |

Each card shows:
- a two-line explanation and its prerequisite, which is always the test wallet (§7);
- an **Open on this phone** button;
- a **QR carrying the page URL**, for a demonstration given from a laptop. It carries only the page
  URL, never an `openid4vp://` request, so it does not add a cross-device flow (ADR 0009 is unaffected);
- a live status dot, from each service's own health route read by the portal on the server side.

**Private part: behind the login (§5).**
- The client-branded demonstrations, when a client profile is active (§4).
- The **operator view**: the console, recent transactions and their outcomes, the audit trail, and the
  profile switch.

## 4. Generic and client-branded profiles

The wallet reads an issuer's display name and logo from **public, unauthenticated** issuer metadata, and
it has no way to present a password there. So a client's brand cannot be hidden behind a login once it
is in the metadata. What can be controlled is **when** it is there. Branding therefore becomes a
**profile**, and there is only ever one active:

| | Generic (default, permanent) | Client profile, e.g. `fnmt-corpme` (per demonstration) |
|---|---|---|
| PID issuer name and logo | "PID Demo Issuer", neutral mark | "FNMT-RCM (demo)", FNMT emblem |
| Representation issuer | "Registro Demo", neutral mark | "CORPME (demo)", CORPME emblem |
| Hosted form look | neutral | FNMT / CORPME (`HOSTED_FORM_BRANDS`) |
| Form and portal pages | public | **behind the login** |
| Duration | always | **auto-reverts after 4 hours** (decided), or earlier at the end of the demonstration |

Switching a profile is configuration only. It already exists piece by piece today:
`ENGINE_ISSUER_DISPLAY_NAMES`, `ENGINE_ISSUER_BRANDING` and `HOSTED_FORM_BRANDS`, followed by
re-provisioning the issuer configuration. The switch becomes one operator action in the portal, and it is
audited.

**The residual risk, stated plainly:** while a client profile is active, anyone who fetches that
issuer's metadata sees the client's name and emblem. That window is short and announced, the name keeps
"(demo)", and the logo URL is served only while the profile is on. It is still public, and the written
permission of the organisation (§8) is what makes it acceptable.

**Alternative, if the metadata may never carry a client's brand publicly:** separate engine tenants per
client (`pid-fnmt`, `rpi-corpme`) whose issuer paths the gateway exposes only while their profile is
active. It is cleaner, but each client then needs its own entries in the wallet's issuer list (WD-5 takes
at most two today) and its own provisioning. It is worth doing only once there is more than one client.

**Documents a wallet already holds keep the name and logo they were issued with.** The wallet stores
issuer display at issue time (§8.1l). A demonstration phone should use a fresh test wallet install per
client.

## 5. Access control for the private part

**Decided: Cloudflare Access** in front of the private hostnames and paths. It uses one-time PINs by
email or a username and password through an identity provider. Access is enforced at the edge, before
anything reaches the VM, and nothing is built into the apps. Each client demonstration gets its own
short-lived credential, revoked afterwards.

**Fallback:** HTTP basic authentication in the portal and the hosted form, with a per-demonstration
password stored as a salted hash in the VM's environment. This is simpler, and only as strong as the
password.

Which paths it covers:

| Protected | Why |
|---|---|
| The portal's private section and the profile switch | Client branding and the operator view |
| The operator console | It holds a tenant key; it has never been public, and must not become public |
| The hosted form **while a client profile is active** | The branded pages. The wallet opens the form in the phone's browser, so the person logs in once there |
| **Not** the engine's protocol paths | The wallet cannot authenticate to them. They stay public and allow-listed as today |

## 6. Security posture for permanent exposure

The current rule is "a tunnel is opened only during a session" (`CLAUDE.md` §6.20,
`test-session-gateway.md`). A permanent environment replaces that rule, so it has to earn the
replacement with the following controls:

1. **Rate limits at the edge.** This is the G7 hardening that `test-session-gateway.md` §3 evaluated and
   left off for short sessions. Always on here: per-IP limits on PAR, token, credential, presentation
   creation, the hosted form and the bank.
2. **Nothing new is exposed.** The gateway allow-list is unchanged, the negative checks run **on a
   schedule** (not only at session start), and any non-`404` alerts.
3. **Secrets generated on the VM**, never in the repository and never on a laptop. The hosted-form,
   hosted-verifier and engine secrets are rotated when the VM is rebuilt.
4. **Nightly reset.** The engine sessions are already purged by their TTL, and the platform's derived
   results by retention. The reset also restores the demonstration configuration to a known state and
   reverts any client profile.
5. **Monitoring.** Uptime checks on each public hostname, the alerts from the scheduled negative checks,
   and disk and memory. No content is logged, as today (ADR 0004).
6. **Updates.** OS security updates are unattended. Platform updates are deployed from this repository's
   main branch. The engine stays on the pinned image (`CLAUDE.md` §2); a new engine release is a
   deliberate change.
7. **The compatibility switch** (`GATEWAY_PINNED_WALLET_COMPAT`, A29) is on permanently, because every
   demonstration uses the pinned test wallet. It is logged as it is today.
8. `security-limitations.md` gains an entry for permanent exposure, with the residual risks: the hosted
   form and the bank can be used by anyone within the rate limits, and client branding is public during
   its window.

## 7. The wallet: the constraint no hosting choice removes

Every demonstration needs the **EDTP test wallet**, a modified build (`tools/test-wallet/`):
- it trusts our development CAs and our TEST lists (WD-3, WD-4);
- it lists our issuers (WD-5);
- it accepts our unsigned issuer metadata (WD-2).

The official Reference Wallet cannot do any of this today (blockers B1 and B3). The APK **is not
published** (`CLAUDE.md` §6.22). So:

- the public portal is visible to anyone, but a visitor can **use** it only with a test wallet installed;
- **decided: demonstrations run on our own Android phones**, with a clean install for each client (§4);
- **Android only**, for now. There is no iOS build of the test wallet;
- **decided: the APK is also offered for download, behind Cloudflare Access**, on the portal's private
  part, as an example for people we give access to. It is never public and never on Google Play. The
  conditions are:
  - a **release** build signed with our own `OU=TEST ONLY` key, **never a debug build**: upstream's
    debug build logs HTTP bodies, PID contents included;
  - the **EUPL 1.2** terms the upstream wallet is licensed under, which is a copyleft licence: the
    EUPL and the Commission's notices ship with it, the download page states that it is a modified
    work and what was changed (`tools/test-wallet/deviations.md`), and it links to
    `tools/test-wallet/` as the source. The repository must be public for that link to satisfy the
    licence. **This reading awaits legal confirmation before the first upload**;
  - a download page that says what the app is: a modified test build, which accepts unsigned issuer
    metadata (WD-2) and trusts only our TEST lists. It is useless for real credentials, and it is not
    the Reference Wallet.

The portal says this plainly on every card, so a visitor never thinks the flow works with the wallet
from the app store.

## 8. Before any client-branded demonstration

- **Written permission** from the organisation to use its name and emblem in a demonstration: FNMT for
  the PID look, CORPME for the representation credentials. Without it, the client profile stays off and
  the generic demonstration is used.
- The client profile's content is reviewed against §4. The demonstration band stays on every page, and
  "(demo)" stays in every issuer name.

## 9. If accepted: the steps, and what they change

1. **ADR 0010**: permanent demonstration environment. It covers hosting, the tunnel on the VM, the
   security posture in §6, and generic versus client profiles.
2. **Provisioning script**: VM bootstrap (Docker, `cloudflared` as a service), compose, the secrets
   generated in place, and the nightly reset.
3. **Edge**: rate limits, Cloudflare Access for the private hostnames and paths, and the scheduled
   negative checks with alerts.
4. **Neutral branding**: a generic brand for the hosted form, and generic issuer names and marks.
5. **`apps/demo-portal`**: the cards, the status dots, the private operator view and the profile switch.
6. **Move DNS**: the `murcata.es` hostnames from the laptop's tunnel to the VM's.

The documents this changes when it is adopted, and not before: `CLAUDE.md` §6.20 (the session-only
rule), `test-session-gateway.md` (a permanent deployment target), `test-session-vm.md` (superseded in
part), `security-limitations.md` (a new entry), and `status.md`.

## 10. Decisions and open questions

Decided on 24 September 2026:

| Question | Decision |
|---|---|
| Provider | **Hetzner Cloud**, EU region; deployments through GitHub Actions and the VM's own tunnel (§2) |
| Access control for the private part | **Cloudflare Access** (§5) |
| Auto-revert window for a client profile | **4 hours** (§4) |
| Wallets on demonstration devices | **Our own Android phones.** No iOS for now (§7) |
| The APK | **Downloadable behind Cloudflare Access only.** A release build, with the EUPL terms. Never public, never Google Play. `CLAUDE.md` §6.22 amended (§7) |
| Public branding | **Generic.** Client branding only as a profile behind the login (§4) |

Still open:
0. Legal confirmation of the EUPL obligations before the first APK upload (§7).
1. Whether a standing authorization covers `deploy-demo` after each merge to `main`, or each deployment
   is confirmed.
2. Whether a second client ever justifies per-client engine tenants (§4, alternative).
