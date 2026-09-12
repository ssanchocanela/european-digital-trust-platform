# Security limitations

**V0 is not production-ready.** Every shortcut is listed here, with what it would take to close
it. Nothing on this list is a bug to be filed; each is a deliberate V0 choice, and the list is
the deliverable.

No ARF or Technical Specification conformance is claimed.

---

## 1. Authentication and authorisation

| # | Limitation | Closing it |
|---|---|---|
| A1 | **One static API key per tenant**, presented as a bearer token. No rotation, no scopes, no expiry, no per-operation authorisation. | OAuth 2.0 client credentials with short-lived tokens, scopes per operation, and key rotation |
| A2 | The bootstrap **administrative key is a single static environment value**. It can create tenants. | A separate administrative plane with its own identity provider and audit |
| A3 | No rate limiting anywhere. A valid key can create unbounded transactions. | Per-tenant quotas and rate limits at the edge |
| A4 | No account lockout or anomaly detection on repeated authentication failures. | Failure counting and alerting |

Mitigations already in place: only a SHA-256 hash of each key is stored, with a short non-secret
prefix for the indexed lookup; comparison is constant-time; the administrative key is **refused**
on every tenant-scoped route, so it cannot act as a tenant (asserted by the smoke script).

## 2. Secrets

| # | Limitation | Closing it |
|---|---|---|
| S1 | The **per-service webhook signing secret is stored in plain text** in `relying_party_services.webhook_secret`. A database dump yields forgeable callbacks. | A managed secret store, or envelope encryption with a KMS-held key |
| S2 | Engine client credentials arrive through `ENGINE_TENANT_CREDENTIALS`, a single environment variable holding every engine tenant's secret. | Per-instance secrets from a secret store, fetched on demand |
| S3 | The engine's `ENCRYPTION_KEY_SOURCE` is left at `env`, which derives its at-rest key from `MASTER_SECRET`. The engine documents this as development-only. | `vault`, `aws` or `azure`, so the key is only ever in RAM |
| S4 | No secret rotation procedure for any of the above. | Rotation runbooks and dual-key windows |
| S5 | **The registration-service login credential (`hash_pid`), the PKCS#12 and its password are secrets.** They live in gitignored local files or `.env` only, are on the log-redaction deny-list, and the pre-commit hook plus `pnpm verify` reject any committed path under `sources/`. They are never in a log, an audit record, a fixture, a document or a commit | A managed secret store, as for S1–S2 |

## 3. Key material and trust

| # | Limitation | Closing it |
|---|---|---|
| K1 | **Access-certificate private keys live in the engine key store**, by default database-encrypted. The platform holds only an opaque reference, so it has no key of its own to protect — but the engine does. | The engine's PKCS#11 or cloud-KMS providers, with per-tenant non-exportable keys |
| K1a | **The reference RP Registration Service generates the key pair server-side** and delivers a PKCS#12, so the private key was outside the subject's control by construction. ARF §3.11.3 describes the access certificate as bound to "a key held by the Relying Party Instance". Accepted for `TEST` only (`interop-findings.md` C8) | A production Access CA accepting a CSR for a key generated in the platform key store, ideally non-exportable |
| K2 | **Path A is the primary route and needs no account:** `registry.serviceproviders.eudiw.dev` authenticates by OID4VP PID presentation. The certificate it issues must be chain-checked against the dev WRPACProviders LoTE **before any wallet test** — `scripts/verify-access-certificate-chain.sh`. The self-built wallet with a platform-operated development Access CA (Path B) is the **fallback**, used only if that check fails; that CA is `TEST`-only and trusted by no production wallet | Path A, plus a production Access CA that accepts a CSR rather than generating the key itself — see K1a |
| K3 | **Trust-anchor management is not implemented.** `EW-PIO-01-028` (`OIA_15a`) obliges a Relying Party to download the latest Trusted Lists and LoTEs, propagate added anchors to every Relying Party Instance and **remove** invalidated or expired ones. V0 delegates trust validation to the engine and does none of this. | A platform-owned trust-resolution service with refresh, propagation, revocation monitoring and fail-closed behaviour |
| K4 | **No registration certificate is available** (blocker B3), so `EW-DM-44-023` (`RPRC_19`) is not satisfied. Each transaction records that it was sent without one. | A reachable provider of registration certificates |
| K5 | The reference environment publishes **byte-identical trust anchors** for PID Providers, access-certificate providers and registration-certificate providers. The platform's model keeps the domains separate, but nothing in V0 verifies that a production environment does. | Per-domain anchor configuration and a test that rejects cross-domain inference |

## 4. Protocol and flow

| # | Limitation | Closing it |
|---|---|---|
| P1 | **The `QR` interaction type does not satisfy `EW-PIO-01-017` (`OIA_08d`).** Four mitigations *are* implemented ([ADR 0009](adr/0009-cross-device-presentation-mitigations.md)), derived from the five challenges in ARF **§4.4.3.2** — not §4.4.3.1, which `OIA_08d` cites in error (`interop-findings.md` D6). Two of the five are addressable by a Relying Party, one partly, two not at all, so the obligation is **not** met. Residual, carried in every cross-device audit record: `NO_PROXIMITY_CHECK` (challenge 1 — needs the DC API and CTAP), `NO_UNIFIED_WALLET_SELECTION` (2), `INCONSISTENT_INVOCATION` (3), `NO_BROWSER_SUPPLIED_ORIGIN` (4). Verified: the pinned Reference Implementation release **does** still scan `openid4vp://` QR codes, so the flow is reachable in practice | The W3C Digital Credentials API with the `EW-PIO-01-020` (`OIA_08g`) proximity check, planned as the iteration after Milestone 1. It is what actually closes challenges 1–4 |
| P1a | **What the QR mitigations do and do not buy.** Implemented: a 120-second lifetime cap (vs 300 same-device); refusal when the access certificate would expire inside the transaction; no completion redirect, so nothing returns to the scanning device and the result is readable only by the authenticated tenant; explicit per-transaction opt-in with an audit record naming the residual risks. **None of this prevents a relay or phishing attack** — it shortens the window, keeps the request attributable, and stops a hijacked context learning the outcome | As P1 |
| P2 | `DECLINED_BY_USER` is **best-effort**. `AS-WP-06-017` (`RPA_11`) requires a Wallet Unit, on user denial, to behave as if the credential did not exist, so a denial is not reliably distinguishable from non-possession. Its absence never implies consent. | Nothing to close: this is the specified wallet behaviour |
| P3 | Out of scope for V0: W3C Digital Credentials API flows, ISO/IEC 18013-5 proximity presentation, and the Article 5b(10) intermediary profile. | Separate milestones |
| P4 | mdoc status checking is **not claimed**. `AS-AP-07-019` (`VCR_11`) requires the mechanism in Annex 2 of the amended CIR 2024/2979; whether the engine's CWT status-list encoding satisfies it is unverified (open question Q4). V0 verifies SD-JWT VC, covered by `AS-AP-07-020` (`VCR_11a`). | Read CIR 2024/2979 Annex 2 against the engine's implementation |

## 5. Privacy

| # | Limitation | Closing it |
|---|---|---|
| V1 | The **engine retains disclosed claims** for the configured session window. Minimised to the transaction lifetime and anonymised on cleanup, but not eliminated. See `privacy.md` §8. | Engine-side support for discarding content at verification time |
| V2 | **`cleanupMode: anonymize` completeness is unverified.** That it nulls every content-bearing field is taken from the engine's documentation and entities, not from an empirical test. | An adapter-contract test asserting the fields are null after cleanup |
| V3 | No DPIA, no data-residency controls, no data-subject-request tooling. | A separate privacy workstream |

## 6. Operations

| # | Limitation | Closing it |
|---|---|---|
| O1 | **Single instance assumed.** Background jobs run in-process on a timer with an in-process re-entrancy guard, so two replicas would both run them. The delivery queue uses `FOR UPDATE SKIP LOCKED` and would be safe, but expiry and purge would duplicate work. | Leader election, or advisory-lock-guarded jobs |
| O2 | No HA, no DR, no backup or restore procedure, no tested rollback. | A productionisation workstream |
| O3 | No metrics and no tracing. Structured logs only. | OpenTelemetry, SLOs, alerting |
| O4 | **The engine's admin API and web client are a full administrative surface.** Compose binds them to `127.0.0.1` and the platform reaches the engine over the internal network only. Exposing that port publicly — which a tunnel for a phone test does — exposes the admin API. **Designed, not yet used:** a default-deny path allow-list with pre-flight negative checks, in [`test-session-gateway.md`](test-session-gateway.md). | A reverse proxy that exposes only the wallet-facing paths, enforced and verified per session |
| O6 | **A test-session tunnel or VM is a deliberate public exposure of a development stack.** Hand-started, open only during a session, synthetic data only, and closed afterwards. Nothing about it is production-grade, and it hides the management API rather than securing it. The tunnel path is **built and has been run**: `apps/test-gateway` enforces the allow-list and `scripts/test-session-tunnel.sh` opens the session, refusing to proceed unless every negative check returns `404`. The **disposable EU-region VM** ([`test-session-vm.md`](test-session-vm.md)) is designed and **not** provisioned, and remains the recommendation for any result that will be recorded — the tunnel exposes a developer laptop and terminates TLS at Cloudflare, which puts a third party inside a test that is partly about trust. | Network-level separation, not an allow-list |
| O7 | **The EDTP test wallet is a MODIFIED build of the Reference Implementation**, signed with our own key (`OU=TEST ONLY`), with a distinct `applicationId` and a banner on every screen. No result from it may be reported as a Reference Wallet result. The APK is never published or distributed. | Nothing to close — it is a test tool. Its deviations are registered in `tools/test-wallet/deviations.md`, default off |
| O5 | The engine is pinned by digest, but there is no automated upgrade gate beyond the adapter-contract suite, which is skipped when no container is present. | The contract suite as a required CI job against a real container |

## 7. Input handling

In place: every request body is parsed by a zod schema with `.strict()`, so unknown fields are
rejected rather than ignored; all database access is parameterised through the query builder, and
no SQL is built by string interpolation; a statement timeout is set at the pool level; callback
URLs must be HTTPS and must **exactly** match an entry registered on the Relying Party Service,
which is the SSRF control; correlation ids from a request header are length- and
character-restricted because they reach the logs; webhook error bodies are truncated before
storage.

| # | Limitation | Closing it |
|---|---|---|
| I1 | No request body size limit beyond the framework default. | An explicit limit at the edge |
| I2 | The imported certificate chain is **not validated** against an expected CA, nor checked for expiry, at provisioning time. The compiler checks `notAfter` only when the platform recorded one. | Chain validation on import, with the expected anchors configured per environment |
| I3 | No CSRF protection on the unauthenticated wallet-return route. It is deliberately inert — it reveals nothing and changes no state — but it is reachable. | Remove it in favour of a front-end-owned return page |

## 8. Supply chain

| # | Limitation | Closing it |
|---|---|---|
| C1 | No dependency scanning or secret scanning in CI yet. The V0 plan requires both. | `pnpm audit` as a CI job, plus secret-scanning configuration |
| C2 | No SBOM. | Generate and publish one per build |
| C3 | Build scripts are opt-in via `allowBuilds` in `pnpm-workspace.yaml`, and the two analytics postinstall scripts (`@nestjs/core`, `@scarf/scarf`) are **explicitly denied** — a small positive, not a complete control. | Review the full dependency and licence tree |

---

## What V0 does get right

Worth stating, so the list above is read as scope rather than as neglect:

- Content has **no table**. The privacy guarantee is structural, and a test scans every table to
  prove it.
- The log redaction deny-list **fails the build** if a denied key survives.
- Tenant isolation is a query predicate, not a later authorisation check, and cross-tenant
  rejection is asserted for reads, writes, results, audit events and the signing secret.
- The protocol engine is confined to one package by a CI boundary check.
- Migrations are checksum-verified, transactional per file, and serialised by an advisory lock so
  two replicas starting together cannot race.
- The engine session window is applied **before** any session is created, so none can exist under
  the engine's 24-hour default.
- A confidentiality guard rejects any committed path under `sources/`, and any committed file that
  cites the internal material there, in both the pre-commit hook and `pnpm verify`. It is scoped to
  the internal subtrees, so citing a public instrument by name stays possible — an unscoped version
  would flag legitimate citations and be switched off within a week.
