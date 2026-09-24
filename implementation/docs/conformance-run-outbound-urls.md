# Outbound URLs a conformance run could contact

**Nothing has been run.** This is the inventory requested before approval, covering the self-hosted
OpenID Foundation suite and our own stack during the `VCIIssuerTestPlanHaip` and
`VP1FinalVerifierTestPlanHaip` plans.

Compiled from the suite's repository configuration and from our own code and configuration. Where a
URL depends on a plan variant or a runtime decision I could not read statically, the row says so
rather than guessing.

---

## A. Build and image pulls — before any test runs

| Host | Why | Avoidable? |
|---|---|---|
| `gitlab.com` | Clone the suite | Yes — clone once, then work offline |
| `repo.maven.apache.org`, `repo1.maven.org` | Maven dependencies for the Java build | Yes — use `docker-compose-prebuilt.yml` and skip the build |
| `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com` | `mongo:6.0.13`, nginx, the suite image | No, unless images are already local |
| `nodejs.org`, `registry.npmjs.org` | The suite's own frontend build | Yes — prebuilt compose |
| `ghcr.io` | Our pinned EUDIPLO image | Already local |

**Smallest footprint:** pull images and clone once, then run with no network except section C.

## B. Runtime, the suite itself

| Host / URL | When | Notes |
|---|---|---|
| `localhost.emobix.co.uk` → **DNS only** | Every run | Public DNS that resolves to `127.0.0.1`. The suite's `base_url` is `https://localhost.emobix.co.uk:8443`, so it gets a real TLS certificate while talking to itself. **A DNS lookup leaves the machine; no traffic does.** Can be removed with a `/etc/hosts` entry |
| `accounts.google.com` | **Only if** `devmode=false` | The admin login path. `docker-compose-dev.yml` sets `--fintechlabs.devmode=true`, which bypasses it — that is why no OIDF account is needed. **If devmode were off, this becomes a hard dependency** |
| `www.certification.openid.net` | **Never**, self-hosted | Only the hosted instance. Not contacted by a local run |
| MongoDB | Every run | Container-local |

## C. Runtime, the plans talking to us

This is the intended traffic, and all of it is local if the suite shares our compose network.

| From → to | Plan | What |
|---|---|---|
| suite → `http://platform-api:3100/v1/...` | both | Creating policies, presentations, issuances |
| suite → `http://eudiplo:3000/presentations/{id}/oid4vp/request` | VP verifier | Fetching our signed request object |
| suite → `http://eudiplo:3000/presentations/{id}/oid4vp` | VP verifier | Posting the `vp_token` response |
| suite → `http://eudiplo:3000/.well-known/openid-credential-issuer/issuers/{t}` | VCI issuer | Our Credential Issuer metadata |
| suite → `http://eudiplo:3000/issuers/{t}/...` | VCI issuer | Token, nonce, credential, notification endpoints |
| our engine → suite | VCI issuer | Wallet-attestation and key-attestation checks, if the plan supplies them |

## D. Runtime, **our stack** reaching out — the rows that need a decision

These are ours, not the suite's, and two of them leave the machine.

| Target | Trigger | Leaves the machine? | Control |
|---|---|---|---|
| `https://trustedlist.serviceproviders.eudiw.dev/LOTE/json/{WRPACProviders,PIDProviders,WRPRCProviders,PubEAAProviders}.jwt` | The engine's ETSI trust resolution, when a credential's chain must be validated. **Likely during the VP verifier plan**, which presents credentials to us | **Yes** — EUDIW dev infrastructure | `LOTE_URL` is configurable; the engine caches with a file cache. Could be pre-seeded or pointed at a local copy, though a stale copy then misrepresents trust |
| Status list URLs inside a presented credential | `statusCheckMode` on the presentation configuration | **Yes, and the URL is chosen by the credential**, so it is whatever the suite's test credential names | Set `statusCheckMode` to none for the run, or accept that the engine fetches a URL the suite controls |
| Any `callbackUrl` on a policy | Only if a test registers one | Depends on the URL | Our allow-list refuses anything not registered; register only a suite-local URL |
| `https://issuer.eudiw.dev`, `https://wallet-provider.eudiw.dev` | **Not by us.** These are the Reference Wallet's configured issuers, and no wallet is involved | No | — |

### The one that deserves attention

**A status list URL inside a test credential is a URL the suite chooses and our engine fetches.** That
is an outbound request to an address decided by a third-party test tool. It is not alarming — the
suite is a reputable OIDF project and the URL will be its own host — but it is the only row where *we*
make a request to somewhere *they* name, so it should be a conscious acceptance rather than a
surprise. Setting `statusCheckMode` off for the run removes it entirely, at the cost of not exercising
status checking.

## E. What is NOT contacted

Stated so the inventory is useful as an assurance, not just a list.

- **No telemetry from us.** `OTEL_SDK_DISABLED=true` on the engine; the platform has no analytics.
- **No Docker Hub credential flow.** Our local workaround runs with no credential helper.
- **No registrar.** None is configured, which is exactly why `RPRC_19` is blocked (gap G2).
- **No wallet, and no wallet provider.** Blocker B7 stands; the suite plays the wallet.
- **No OIDF submission.** Certification needs the hosted instance and an account; not proposed.

## F. Recommended run profile, if approved

1. Pull images and clone with network on; then **disconnect for sections A and B**.
2. Attach the suite to the `edtp-v0` compose network, so section C is container-local.
3. Add `127.0.0.1 localhost.emobix.co.uk` to `/etc/hosts`, removing even the DNS lookup.
4. Decide section D explicitly:
   - **Option 1 (tightest):** `statusCheckMode` off and a pre-seeded LoTE cache. No outbound traffic
     at all during the run. Does not exercise status checking or live trust resolution.
   - **Option 2 (most faithful):** allow the four dev LoTE URLs and the suite's status list. Two
     outbound destinations, both known.
5. Run `VP1FinalVerifierTestPlanHaip` first, capture the report, and review before the issuer plan.

**My recommendation: option 2**, because trust resolution and status checking are exactly the parts an
independent implementation is useful for testing, and both destinations are known and reputable. But
that is a decision to take, not an assumption to make — which is why nothing has run.
