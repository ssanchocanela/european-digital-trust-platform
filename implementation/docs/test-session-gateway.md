# Test-session gateway — design

**This was the design, written before anything was opened.** It is kept as written; what changed is
recorded in the box below.

> **Status, 12 September 2026: built, and run.** The allow-list in §1 is now enforced code in
> [`apps/test-gateway`](../apps/test-gateway/), the session is opened by
> [`scripts/test-session-tunnel.sh`](../scripts/test-session-tunnel.sh), and a session **has been
> opened** — the fourteen negative checks in §4 all returned `404` over the public hostnames, and a
> wallet-facing signed request object was fetched over public HTTPS. Blocker **B5** is closed.
>
> One thing the design did not anticipate, in §2: a Cloudflare **quick tunnel** — the kind needing no
> account and no domain — has no path-level ingress rules. It forwards every path on its hostname to one
> port, which pointed at the engine would publish `/api/*` outright. So the filtering happens in a
> reverse proxy **in front of** the tunnel rather than in the tunnel's own configuration. Named tunnels
> with `ingress` rules still work as sketched, and need an account and a domain.
>
> One operational surprise: a quick tunnel can register successfully and be handed a hostname that
> answers `NXDOMAIN` indefinitely. The script now verifies DNS and retries rather than waiting it out.

The design exists because the single largest operational risk in the wallet workstream is putting a
tunnel in front of port 3000 and publishing the engine's management API by accident.

A phone cannot reach `localhost`, and the wallet refuses cleartext
(`network_security_config.xml`: `<base-config cleartextTrafficPermitted="false" />`). So a wallet test
needs the engine and, for same-device verification, the platform reachable over **public HTTPS with an
OS-trusted certificate**. That is blocker **B5**, and this document is how it is closed without
opening anything else.

Two rules frame everything below:

- **The tunnel is open only during a test session**, and closed immediately afterwards. It is started
  by hand, never by `docker compose up`, and never left running.
- **Synthetic data only.** No real identity document, photograph or personal data goes near it.

---

## 1. What is exposed: a closed allow-list

Default deny. A path not listed here is not reachable, and the gateway returns `404` for it — not
`403`, which would confirm that something is there.

### 1a. The engine's wallet-facing paths, on the tunnel host for the engine

EUDIPLO serves two OpenAPI documents on one port: the **Protocol API** unprefixed, and the
**Management API** under `/api`. Only the first is a wallet's business.

| Method | Path pattern | Needed for |
|---|---|---|
| `GET` | `/.well-known/openid-credential-issuer/issuers/{tenantId}` | IaaS — Credential Issuer metadata |
| `GET` | `/.well-known/oauth-authorization-server/issuers/{tenantId}` *(and `/authorization-servers/{id}`)* | IaaS — authorization server metadata |
| `GET` | `/.well-known/jwks.json/issuers/{tenantId}` *(and the `authorization-servers`/`chained-as` variants)* | IaaS — issuer keys |
| `GET`, `POST` | `/presentations/{sessionId}/oid4vp/request` | VaaS — fetching the signed request object |
| `POST` | `/presentations/{sessionId}/oid4vp` | VaaS — the `vp_token` response |
| `GET` | `/presentations/{sessionId}/oid4vp/request/no-redirect` | VaaS — cross-device variant |
| `GET` | `/issuers/{tenantId}/vci/credential-offers/{sessionId}` | IaaS — resolving a credential offer |
| `POST` | `/issuers/{tenantId}/vci/credential` | IaaS — the credential request |
| `POST` | `/issuers/{tenantId}/vci/nonce` | IaaS — nonce endpoint |
| `POST` | `/issuers/{tenantId}/vci/notification` | IaaS — notification endpoint |
| `GET` | `/issuers/{tenantId}/authorize` | IaaS — authorization endpoint |
| `POST` | `/issuers/{tenantId}/authorize/par`, `/authorize/token` | IaaS — PAR and token |
| `GET` | `/issuers/{tenantId}/status-management/status-list/{listId}` | Revocation — status list retrieval |
| `GET` | `/issuers/{tenantId}/credentials-metadata/vct/{id}` | IaaS — VCT metadata |

Added **only when the flow under test needs them**, not pre-emptively:

| | |
|---|---|
| `/issuers/{tenantId}/authorization-servers/{id}/{authorize,par,token,vp-callback}` | Only with PID-during-issuance, which is off by default |
| `/presentations/{sessionId}/iso-18013-7` | Only for a proximity test, which V0 does not do |
| `/issuers/{tenantId}/vci/deferred_credential` | Only if deferred issuance is tested |
| `/issuers/{tenantId}/trust-list/{id}`, `/status-management/status-list-aggregation` | Only when publishing a list through the engine |

### 1b. The platform, on a separate tunnel host

**One route**, and only for same-device verification:

| Method | Path | Why |
|---|---|---|
| `GET` | `/v1/presentations/{presentationId}/return` | Where the wallet returns the user's browser after a same-device flow. Already `@Public()` and deliberately minimal — it echoes the id and a sentence, and reveals no outcome |

**The issuance flow needs no platform route at all.** The credential offer URI points at the engine, and
the platform has no public issuance endpoint. A useful result: the IaaS matrix rows need only the engine
host.

### 1c. Never exposed — and why each one matters

| Never | Consequence if it were |
|---|---|
| `/api/*` on the engine | The **entire Management API**: `POST /api/key-chain/import`, tenant creation, presentation and issuance configuration. Protected only by a client-credentials secret. This is the one that must not happen |
| `/api/docs`, `/api/docs-json`, `/docs`, `/docs-json` | Publishes the surface map of both APIs |
| `/health` on either service | The platform's reports engine reachability; both are internal signals |
| `/storage/{key}` on the engine | An opaque key-addressed store, not part of either flow |
| `/` on the engine | Landing page, version disclosure |
| Every other platform route | `/v1/tenants/**` is tenant and provider **management**: organisations, services, policies, providers, certificate import, revocation. All of it is admin, authenticated by an API key that must never be presented to a public endpoint |
| Postgres (5432) | Both databases are compose-internal and bound to `127.0.0.1` |

### 1d. Enforcement, not intention

An allow-list that lives in a document is a wish. It must be enforced at the edge:

0. **`apps/test-gateway` is the enforcement.** The rules in §1a and §1b are its
   [`allow-list.ts`](../apps/test-gateway/src/allow-list.ts), default-deny with a `404`, the method part
   of the decision, patterns anchored at both ends, and the path normalised *before* it is matched —
   deciding on an un-normalised path is the classic hole. Eleven unit tests probe it the way an attacker
   would: `/api/*` under five methods, traversal in both directions, percent-encoded traversal, an
   identifier containing a separator, and a query string smuggling an allowed path. The negative probes
   of §4 live in that same file, and a test asserts they are genuinely refused — so a carelessly added
   rule and the check that would catch it are reviewed together.
1. **Keep the compose bindings as they are** — `127.0.0.1:3000` and `127.0.0.1:3100`. The tunnel
   connects to the gateway, the gateway connects to localhost; nothing else can.
2. **Two tunnel hostnames**, one per service, so an engine path can never resolve on the platform host
   or the reverse.
3. **Path allow-list in the gateway** (the reverse proxy in front of the tunnel, or the tunnel's own
   ingress rules), expressed as anchored regexes with a default-deny terminal rule.
4. **A closing assertion**: before any wallet interaction, run the negative checks in §4 against the
   public hostnames. A tunnel is trusted only after it has been shown to refuse the things it must.

## 2. How the stack is reached — two options, and this document governs both

**There is now a second option, and it is the recommended one for recorded evidence:** a disposable
EU-region VM with our own domain and Let's Encrypt certificate, designed in
[`test-session-vm.md`](test-session-vm.md), which compares the two on security, corporate-policy exposure
and fidelity. The short version: the tunnel is the fast path for a first "does the phone reach us at all"
check; the VM is what any run whose result will be recorded should use, because an inbound tunnel to a
corporate-network laptop is a policy problem regardless of its technical soundness, and because
Cloudflare terminating TLS puts a third party inside the thing under test.

**The allow-list in §1 governs either deployment**, and so do the negative checks in §4.

| Option | Verdict |
|---|---|
| **Cloudflare Tunnel (`cloudflared`)** | **The fast path.** Minutes to set up: a stable hostname, a real certificate, no inbound ports, and ingress rules with `path` matching, so the allow-list lives in the tunnel's own configuration rather than in a second proxy. Cloudflare terminates TLS, so the phone validates *their* certificate |
| ngrok | Works. The free tier's rotating hostname is the problem: `ENGINE_PUBLIC_URL` is baked into every wallet-facing URL the engine emits, so a changed hostname invalidates in-flight sessions |
| Tailscale Funnel | Works, and pleasantly small, but path-level filtering needs a proxy behind it |
| **Disposable EU VM + nginx** | **Recommended for recorded evidence.** Most control and most setup, and a machine to keep patched — which is why it is destroyed between sessions rather than kept. Fully designed in [`test-session-vm.md`](test-session-vm.md) |

### The ordering constraint that bites

`ENGINE_PUBLIC_URL` must be the **public origin before the first session is created**. It is baked into
the credential offer and request URIs, so changing it afterwards breaks sessions already in a wallet.
The same applies to `PLATFORM_PUBLIC_URL` for the same-device return URL. So the order is: start the
tunnel, learn the hostnames, set both variables, **then** `docker compose up`, then create sessions.

A sketch of the ingress, to be written properly when a session is actually prepared:

```yaml
# cloudflared — illustrative, not yet in use. Default-deny is the last rule, and it 404s.
ingress:
  - hostname: engine.<test-domain>
    path: ^/(\.well-known/(openid-credential-issuer|oauth-authorization-server|jwks\.json)/issuers/|presentations/[^/]+/oid4vp|issuers/[^/]+/(vci|authorize|status-management|credentials-metadata)/)
    service: http://127.0.0.1:3000
  - hostname: platform.<test-domain>
    path: ^/v1/presentations/[^/]+/return$
    service: http://127.0.0.1:3100
  - service: http_status:404
```

## 3. G7 edge hardening — evaluated, and **recommended off by default**

The question: strip `path`, `timestamp` and `statusCode` from non-2xx JSON bodies on wallet-facing
routes, preserving OpenID4VP `error` and `error_description`.

### What G7 actually is

On a failed presentation the engine answers the `direct_post.jwt` POST with its generic NestJS error
envelope:

```json
{ "statusCode": 400, "timestamp": "2026-09-11T19:00:07.884Z",
  "path": "/presentations/…/oid4vp",
  "redirect_uri": "http://localhost:3100/v1/presentations/…/return?error=invalid_request&…" }
```

Two problems: OpenID4VP 1.0 Final §8.2 constrains what this response may contain, and `path` discloses
internal routing. Note what is **not** there — no `error`, no `error_description` — and what must
survive untouched: **`redirect_uri`**, which §8.2 does define and which the Wallet acts on.

### Is it in scope, or is it the thing we refused to do?

Worth being straight about, because it is adjacent to a decision already taken: *do not work around
engine gaps by signing or rewriting engine output.* The line that keeps this on the right side of that
decision is narrow and must be held exactly:

| Allowed | Not allowed |
|---|---|
| **Removing** keys the protocol does not define, from non-2xx `application/json` bodies only | Adding any key |
| A fixed deny-list of exactly `statusCode`, `timestamp`, `path` | A general "normalise the error" transform |
| Only on the allow-listed wallet-facing paths | Anywhere else |
| Leaving `redirect_uri`, `error`, `error_description` and every other key byte-identical | Renaming, reordering or re-encoding |
| Leaving the HTTP status code alone | Changing the status |

That is response minimisation at the edge, the same class of thing as removing a `Server:` header. It is
not protocol authorship: nothing is signed, nothing is invented, and a Wallet that ignores the extra
keys sees an identical response either way.

### Why it should nevertheless default to **off**

Three reasons, and the second is the decisive one.

1. **G7 is low severity.** A Wallet must tolerate unknown members in a JSON response; the disclosure is
   an internal route, on a host that exists only during a test session.
2. **With stripping on, our evidence would stop describing the engine.** A conformance run through a
   stripping gateway would show G7 as absent when it is not, and the entire value of that suite is that
   it reports the engine as it is. The gap was found by sending traffic at the engine unmodified; that
   must stay possible and must stay the default.
3. **It puts the gateway inside a protocol exchange.** Cheap now, and a thing to remember later. The
   real fix is upstream — drafted as G7's upstream issue.

### Therefore

| | |
|---|---|
| Implement | Yes, as an explicit opt-in: `GATEWAY_STRIP_NONPROTOCOL_ERROR_KEYS=true` |
| Default | **Off** |
| Forbidden while on | Any conformance run, and any run whose purpose is to evidence an engine gap |
| Log | One line per activation — path and the keys removed, **never the body** — so silent drift is impossible |
| Record | If a run had it on, the run record says so. A result obtained through a modified error path is a modified result |

Its one legitimate use: a wallet that refuses to parse the response at all, blocking a test for a reason
unrelated to what the test is about. That has **not** been observed — the pinned wallet has not been run
against us at all yet — so this stays off until something actually needs it.

## 4. Session checklist

### Opening

1. `scripts/verify-access-certificate-chain.sh` (Q1a) — **before** anything is exposed.
2. Start the tunnel; note both hostnames.
3. Set `ENGINE_PUBLIC_URL` and `PLATFORM_PUBLIC_URL` to those origins. **Then** `docker compose up`.
4. Run the negative checks below. **Do not proceed if any of them returns anything but `404`.**

```bash
# Every one of these MUST be 404. A 200, 401 or 403 means the allow-list is wrong — a 401 is
# not reassurance, it is proof the endpoint is reachable.
for u in \
  "https://engine.$D/api/docs-json" \
  "https://engine.$D/api/tenant" \
  "https://engine.$D/api/key-chain" \
  "https://engine.$D/health" \
  "https://engine.$D/storage/x" \
  "https://engine.$D/" \
  "https://platform.$D/v1/tenants" \
  "https://platform.$D/health" \
  "https://platform.$D/v1/presentations" ; do
  printf '%s  %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "$u")" "$u"
done
```

5. Confirm the positive path too, so a green negative sweep is not just a broken tunnel:
   `curl -s -o /dev/null -w '%{http_code}' "https://engine.$D/.well-known/openid-credential-issuer/issuers/$TENANT"` → `200`.

### Closing

1. Stop the tunnel. Do not leave it up "for tomorrow".
2. `docker compose down`, or reset `ENGINE_PUBLIC_URL` to localhost so a stale public origin cannot be
   baked into a later session.
3. Write the run record while the session is fresh.

## 5. What this design does not do

- **It does not make the deployment production-ready**, and nothing here may be described that way. It
  is a temporary, hand-started exposure of a development stack holding synthetic data.
- **It does not secure the engine's management API** — it hides it. The API is still there, on
  localhost, with a client-credentials secret. A production deployment would need network-level
  separation, not an allow-list.
- **It does not fix G7**, by design. See §3.
- It belongs in `docs/security-limitations.md` as a listed shortcut once a session has actually been
  run.
