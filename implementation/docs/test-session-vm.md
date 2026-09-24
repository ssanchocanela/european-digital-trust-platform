# Disposable test-session VM — design

**Designed, not provisioned.** No VM exists, no domain is registered, no certificate has been issued.
This is the alternative to the tunnel in [`test-session-gateway.md`](test-session-gateway.md), written so
the choice between them can be made on evidence rather than on whichever one someone starts building.

Same two standing rules as the tunnel: **up only during a test session**, and **synthetic data only**.

---

## 1. Why this option exists at all

Three reasons, in the order they actually matter.

1. **Corporate-policy exposure.** A tunnel punches an inbound path from the public internet to a
   developer laptop on a corporate network. Many security policies prohibit exactly that, and a tunnel
   that is technically sound can still be the wrong thing to have done. A VM in a cloud account moves the
   exposure to infrastructure that is supposed to be exposed.
2. **Fidelity.** The deployment stops being "a laptop with a hole in it" and becomes a small server with
   its own DNS name and its own certificate — closer in shape to how this would really run, and therefore
   a test whose result generalises further.
3. **TLS interception.** A laptop behind a TLS-intercepting proxy is an awkward place to serve TLS from.
   A VM outside that perimeter has no such problem, and the phone reaching it over mobile data sees
   exactly the certificate we issued.

## 2. Shape

| | |
|---|---|
| Region | **EU** — Frankfurt, Amsterdam, Dublin, Paris or Stockholm. Synthetic data only, so this is about keeping the habit rather than a legal necessity; a future run with anything resembling real data must be EU-region, so the habit should start here |
| Size | 4 GB RAM, 2 vCPU, 40 GB disk. The engine, the platform and two Postgres containers fit comfortably; the wallet APK is not hosted here |
| OS | Current Debian or Ubuntu LTS, unattended security upgrades on |
| Cost | Single-digit euros a month, and it is destroyed between campaigns |
| Domain | One real domain we control, with two names: `engine.<test-domain>` and `platform.<test-domain>`. **Never a name that could be mistaken for an official EUDI or Commission host** |
| TLS | **Let's Encrypt**, ACME, automatic renewal. A real, publicly-trusted certificate is the point: the wallet requires an OS-trusted chain and refuses cleartext |
| Gateway | **The same allow-list as the tunnel**, same default-deny, same negative checks. One source of truth, two deployment targets |

### Two names, not one

Exactly as in the tunnel design, and for the same reason: with one hostname a path mistake on the engine
host can resolve on the platform host. Two names, two server blocks, two upstreams, and an engine path is
structurally unable to reach the platform.

### Network-level closure as well as path-level

This is the VM's real advantage over the tunnel, and it should be used rather than merely available:

| Layer | Rule |
|---|---|
| Cloud firewall / security group | Inbound **443 only**, from anywhere (the phone is on mobile data, so the source is not predictable). Inbound **22 only from the operator's current address**, and closed between sessions |
| Host firewall | The same, as a second independent statement |
| Docker bindings | `127.0.0.1:3000` and `127.0.0.1:3100`, unchanged from the compose file. The reverse proxy is the only thing that reaches them |
| Reverse proxy | The path allow-list, default-deny `404` |
| No direct container ports | Never `-p 3000:3000` on a public interface. This is the single mistake that would undo everything above |

Four independent layers, and the allow-list is the last of them rather than the only one. The tunnel has
effectively two.

### Reverse proxy sketch

Illustrative, not in use. The path set is the one in
[`test-session-gateway.md`](test-session-gateway.md) §1a/§1b — that document stays authoritative, and
this is a rendering of it.

```nginx
# Default server: answer anything unmatched, and 404. No default_server vhost leaking a real host.
server {
  listen 443 ssl default_server;
  ssl_certificate     /etc/letsencrypt/live/engine.<test-domain>/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/engine.<test-domain>/privkey.pem;
  return 404;
}

server {
  listen 443 ssl;
  server_name engine.<test-domain>;

  # Wallet-facing Protocol API only. /api/* is absent, so it 404s on the rule below.
  location ~ ^/\.well-known/(openid-credential-issuer|oauth-authorization-server|jwks\.json)/issuers/ { proxy_pass http://127.0.0.1:3000; }
  location ~ ^/presentations/[^/]+/oid4vp(/request(/no-redirect)?)?$                                 { proxy_pass http://127.0.0.1:3000; }
  location ~ ^/issuers/[^/]+/(vci|authorize|status-management|credentials-metadata)/                  { proxy_pass http://127.0.0.1:3000; }
  location / { return 404; }
}

server {
  listen 443 ssl;
  server_name platform.<test-domain>;

  location ~ ^/v1/presentations/[^/]+/return$ { proxy_pass http://127.0.0.1:3100; }
  location / { return 404; }
}
```

Three details that are easy to get wrong and expensive to miss:

- **A `default_server` that returns 404** means an unknown `Host:` header reaches nothing. Without it,
  nginx serves the first block to any hostname, and the two-name separation is decorative.
- `/issuers/{tenantId}/authorize` without a trailing segment is a **real endpoint** (the authorization
  endpoint) and the regex above, ending in `/`, would miss it. Add it explicitly when IaaS is tested —
  and then test that it is reachable, rather than assuming.
- The engine's own `/health` is **not** in the list, so the cloud provider's HTTP health check cannot use
  it. Use a TCP check on 443, or a `GET /` on the default server expecting 404.

## 3. Start and stop

The whole point is that the exposure is short-lived, so the procedure is written as two scripts rather
than a list of habits.

### Start

1. Open SSH to the operator's current address only.
2. `git clone` at the platform commit under test; bring up `docker compose` with
   `ENGINE_PUBLIC_URL=https://engine.<test-domain>` and
   `PLATFORM_PUBLIC_URL=https://platform.<test-domain>` **set before the first `up`** — the engine bakes
   these into every wallet-facing URL it emits, so setting them afterwards breaks sessions already in a
   wallet.
3. `certbot` once per certificate; renewal is automatic but a VM that only exists for a few days at a
   time will often need a fresh issue rather than a renewal. **Use staging first** while the
   configuration is being shaken out — Let's Encrypt's production rate limits are per-domain-per-week and
   a few failed attempts can cost a session.
4. Open 443.
5. Run the negative checks from `test-session-gateway.md` §4 against the **public** names. **Do not
   proceed unless every one returns 404**, and confirm one positive path too so a clean sweep is not just
   a broken proxy.
6. Record the VM's identity in the run record: provider, region, instance id, IP, platform commit, engine
   digest.

### Stop

1. Close 443 at the cloud firewall. This is the first step, not the last: it is one action and it ends
   the exposure immediately.
2. `docker compose down -v` — the volumes hold the engine's database, which has held session data.
3. **Destroy the instance.** Not "stop" it. A stopped instance keeps its disk, and a disk that has held
   presentation sessions is a thing to be rid of.
4. Close SSH, or destroy the key.
5. Write the run record while the session is fresh.

> **Destroy, don't stop, is the rule that makes this "disposable".** A VM that is merely stopped between
> sessions accumulates state, drifts from the committed configuration, and becomes something nobody wants
> to rebuild — at which point it is a long-lived server with a test server's security posture. If the
> rebuild is too tedious to do each time, automate the rebuild; do not keep the VM.

## 4. Tunnel versus VM

Honestly, on the three axes asked for.

| | Tunnel (`cloudflared`) | Disposable EU VM |
|---|---|---|
| **Security — exposure** | Inbound path to a **developer laptop** on a corporate network. No inbound ports opened, but the laptop is reachable from the internet for the duration | Exposure lands on a **throwaway VM** with nothing else on it. The laptop is never reachable |
| **Security — blast radius** | The laptop holds source, credentials, SSH keys, possibly the signing keystore. A gateway mistake exposes a machine that matters | The VM holds a checkout and synthetic data. A gateway mistake exposes something we destroy anyway |
| **Security — defence in depth** | Two layers: the tunnel's ingress rules and the localhost bindings | Four: cloud firewall, host firewall, localhost bindings, proxy allow-list |
| **Security — who holds the TLS key** | Cloudflare terminates TLS. The certificate the phone validates is **theirs**, and the traffic is decrypted at their edge | We hold the key. The phone validates **our** certificate, end to end |
| **Security — new dependency** | A third party in the data path for every wallet interaction | A cloud provider hosting the VM, but not in the TLS path |
| **Corporate-policy exposure** | **The weak point.** An inbound tunnel to a corporate-network laptop is prohibited by many policies, and plausibly by this one. It may also traverse the same proxy that already interferes with TLS | Ordinary cloud usage. Needs an account and a spend approval, and nothing about it is unusual |
| **Fidelity** | Lower. Wallet-facing URLs carry a provider hostname; TLS is someone else's; the topology is not one anybody would run | **Higher.** Our domain, our certificate, a reverse proxy in front of localhost-bound containers — the shape a real deployment has |
| **Setup cost** | **Minutes.** Install `cloudflared`, write ingress rules | **Hours** the first time: account, domain, DNS, VM, compose, certbot, proxy, firewall. Then minutes, if scripted |
| **Per-session cost** | Near zero | Single-digit euros, plus a few minutes to rebuild |
| **Hostname stability** | Stable with a Cloudflare account and a named tunnel; **rotating** on ngrok's free tier, which is the trap, because `ENGINE_PUBLIC_URL` is baked into emitted URLs | Stable by construction — it is our DNS |
| **Conformance-suite use** | Awkward: the suite would reach us over the public internet, losing the egress-free property | Same consideration, but the VM can also host the suite **beside** the stack, keeping that traffic internal |
| **Failure mode when misconfigured** | A public path to a laptop | A public path to a VM that gets destroyed |

### Recommendation

**The disposable EU VM, for anything beyond a first smoke test** — and the deciding reasons are the two
that are not about convenience:

1. **Corporate-policy exposure.** An inbound tunnel to a corporate-network laptop is the kind of thing
   that is a problem *regardless* of whether it was technically safe. The VM needs permission of an
   ordinary kind, which is a better position to be in than needing forgiveness.
2. **We hold the TLS key.** With Cloudflare terminating TLS, the certificate the wallet validates is
   Cloudflare's and the traffic is decrypted at their edge. For a functional test that is irrelevant. For
   anything that is *about trust* — and gate (a), gate (b) and access-certificate validation all are — it
   puts a third party inside the thing under test. Having just written a page telling the operator to
   avoid TLS interception on the phone, terminating TLS at a third party on the server side would be
   inconsistent.

**Keep the tunnel as the fast path** for a first "does the phone reach us at all" check, where nothing is
being claimed and speed is worth more than fidelity. Switch to the VM before any run whose result will be
recorded as evidence.

Cloudflare Tunnel's own origin-certificate mode narrows the TLS point — traffic is re-encrypted to our
origin — but the public-facing certificate is still theirs, so the objection stands in reduced form.

### What does not differ

**The allow-list, and the obligation to verify it.** Both deployments use the same path set and the same
pre-flight negative checks, and in both a `401` on an `/api/*` probe is a failure rather than a
reassurance — it proves the endpoint is reachable. The gateway design document remains the single source
of truth for what may be exposed; this document only describes a second place to enforce it.

## 5. What this design does not do

- **It does not make the deployment production-ready**, and nothing here may be described that way. It is
  a deliberately short-lived host for a development stack holding synthetic data.
- **It does not secure the engine's Management API.** Four layers hide it; none of them is the network
  separation a real deployment needs.
- It adds a cloud account and a domain to the set of things that must be paid for, patched and eventually
  cleaned up. The "destroy, don't stop" rule is what keeps that set small.
- It belongs in [`security-limitations.md`](security-limitations.md) as a listed shortcut once a session
  has actually been run — as **O6** already anticipates for the tunnel.
