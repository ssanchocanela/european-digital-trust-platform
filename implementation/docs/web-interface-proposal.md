# Web interface for operating V0 — proposal

**A proposal, not a decision.** Nothing here is built. It exists so the choice can be made on scope and
constraints rather than on whichever screen someone starts writing.

V0 has no web interface today. The only application in the repository is `apps/platform-api`, a REST
API, and the three Swagger UIs that exist (`:3100/openapi`, and the engine's `:3000/api/docs` and
`:3000/docs`) are generated documentation with a "try it" button — not an operating surface.

---

## 1. "Operating V0" means three different products — they should not be one

Conflating them is the expensive mistake, because they have different audiences, different lifetimes and
incompatible security postures.

| | Audience | Purpose | Lifetime |
|---|---|---|---|
| **A. Test driver** | Us, during wallet tests | Start a presentation, show the QR or same-device link, watch the outcome | Throwaway. Dies when V0 does |
| **B. Operator console** | Us, operating the platform | Provision tenants and services, import certificates, inspect transactions and audit trail, check engine health | Medium. Becomes internal tooling |
| **C. Customer portal** | Relying Parties and Attestation Providers | Self-service policies, intended uses, webhooks, API keys, usage | The real product surface. **Post-V0** |

**Recommendation: build A now, B next if it earns itself, and do not start C.** The reasoning is in §2.

C is the one that looks most like "the product" and is the worst use of effort now: it would bake a
product model into screens while the domain is still moving, and it needs the things V0 deliberately
lacks — accounts, roles, billing, audit export, an SLA. It is a post-V0 workstream with its own
discovery.

## 2. Why the test driver first

Look at what a wallet test actually needs next week, per
[`vaas-official-wallet-run-sheet.md`](vaas-official-wallet-run-sheet.md): create a presentation, get an
interaction URI, **put it in front of a phone**, and read the outcome. Today that is `curl`, copying a
URI into a QR generator, and `curl` again to poll.

That is not a tooling inconvenience, it is a **source of invalid results**. A hand-assembled QR, a URI
pasted with a truncated character, a polled status read at the wrong moment — each produces a failure
that looks like a platform or wallet failure. The run sheet's value depends on the failure modes being
the ones under test.

So the test driver is the one piece of UI that pays for itself immediately, and it is small:

| | |
|---|---|
| One page | Pick a published policy, choose `SAME_DEVICE` or `QR`, press Start |
| Renders | The interaction URI as a link **and** as a QR, generated server-side |
| Polls | `GET /v1/presentations/{id}` until a terminal state, showing status transitions with timestamps |
| Shows | Exactly the result-policy output, and `failureCode` when there is one |
| Records | The run-record fields the sheet asks for, pre-filled from the engine and the build |

The last row is the quiet win: the sheet's record template currently gets filled in by hand, afterwards,
from memory. A page that emits it is a page that makes the evidence better rather than just faster.

## 3. The two constraints that decide the architecture

Neither is negotiable, and both are cheap if designed in and expensive if retrofitted.

### 3.1 A browser is a new persistence surface — privacy is the binding constraint

`CLAUDE.md` §5 and [ADR 0004](adr/0004-ephemeral-presentation-and-issuance-processing.md): presentation
and issuance **content** is never persisted, never logged, and `AS-RP-01-002` (`OIA_16`) constrains the
customer-facing *result*, not only storage. The platform *is* the Relying Party Instance in the hosted
profile, so that binds us.

A web UI quietly adds four places content could land that no API client has:

| Surface | Mitigation |
|---|---|
| `localStorage` / `sessionStorage` | **Forbidden for anything transaction-related.** Nothing from a result is written to browser storage |
| Browser history and the URL | **No attribute values, no tokens, no ids in query strings.** Ids in path segments only |
| Screenshots, which end up in documents and issues | The result panel shows only the result-policy output, and is **labelled** with the policy version that produced it, so a screenshot is self-describing |
| A "show raw response" affordance | **Never built.** Not behind a flag, not for debugging. The moment it exists, someone screenshots a PID |

One rule covers all four: **the UI renders exactly what the API returns and has no privileged view.** It
is another API client, with no back channel. If an operator needs more than the API exposes, the answer
is a change to the API's contract — deliberate, reviewed, tested — not a UI that reaches around it.

### 3.2 A tenant API key must not live in a browser

`CLAUDE.md` §9: the tenant is derived from the authenticated credential, and a `tenantId` in a path is
only checked against it. The credential is a long-lived bearer token.

Handing one to JavaScript would make every XSS a tenant compromise, and a V0 console is exactly where
someone would paste a production key "just to look". So:

- the key lives **server-side only**, in the console's own process, from its environment;
- the browser holds a **session cookie** — `HttpOnly`, `Secure`, `SameSite=Strict`;
- the console calls the platform API server-to-server and never proxies arbitrary paths — each screen
  maps to a named server action, so the console cannot be turned into an open relay to the API.

This is the standard BFF shape, and it is the reason the console is a **separate application** rather
than routes bolted onto `platform-api` (§4).

### 3.3 Exposure — and the one genuine exception

[`test-session-gateway.md`](test-session-gateway.md) §1c: platform management routes are **never**
publicly exposed. The console is management. So it binds to `127.0.0.1`, is reached over SSH port
forwarding or a VPN, and **is not added to the gateway allow-list**.

The exception needs care, because it is real. A true **same-device** test requires the page that starts
the presentation to be open *on the phone*. That page must therefore be reachable publicly — so it is
**not** part of the console:

| | Console | Test-start page |
|---|---|---|
| Bound to | `127.0.0.1` | Public, through the gateway |
| Can | Everything below | Start a presentation for **one pre-configured policy**, and render the URI |
| Cannot | — | List anything, read a result, reach any management route, or see another tenant |
| Session | Operator session | **None.** A single-use, expiring start token, minted by the console |

Two separate deployables with separate allow-list entries, because "one app with a public route" is how
the management surface ends up public. Cross-device (`QR`) needs no public page at all — the QR is shown
on the laptop — which is another reason `SAME_DEVICE` and `QR` stay separately recorded.

## 4. Shape

### A separate application, server-rendered

```
apps/operator-console/        Nest + server-rendered templates, minimal JS, :3200, 127.0.0.1
apps/test-start/              The one public page, :3201, behind the gateway   (only if same-device)
```

**Server-rendered with a few hundred lines of JS, not a SPA.** Justification, since the default instinct
is React:

| | Server-rendered | React SPA + BFF |
|---|---|---|
| Build pipeline | None beyond the existing `tsc` | A bundler, a second toolchain in a pnpm workspace that currently has one |
| Token handling | A cookie. The key never leaves the server | A BFF anyway — so the same server, plus a client |
| Attack surface | HTML and one cookie | Plus a JS bundle, CORS, and client-side routing |
| Polling and a QR | `fetch` in a `<script>`; QR rendered server-side as SVG | The same, with more machinery |
| Fits `CLAUDE.md` §3.7 | Yes — "don't over-engineer V0" | Not really |

The screens are forms, tables and a status poller. Nothing here needs a client-side framework, and the
one thing that genuinely would — a rich policy editor — belongs to product C, which is not being built.

### Screens, if B is approved

| Screen | Reads | Writes |
|---|---|---|
| Tenants | *needs a new list route* | Create tenant (admin key, key shown once) |
| Services and intended uses | *needs new list routes* | Create, record registration certificate |
| Certificates | Provisioning state | Import access certificate — **file upload of a PKCS#12, passphrase never logged, never written to disk** |
| Policies | *needs new list routes* | Publish a version (immutable, so publish-only) |
| Presentations | `GET /v1/presentations/{id}` | Start one |
| Audit | *needs a new route over `AuditService.listForPresentation`* | — |
| Issuance | Provider authentication evidence, issued credentials | Revoke, suspend, reinstate |
| Health | `/health`, engine reachability, migration state | — |

## 5. The honest majority of the work is API, not UI

Five of the eight screens above are blocked on endpoints that **do not exist**. I checked: every route is
`POST` or `GET`-by-id, and there is **no list route anywhere** in the API. `AuditService` has
`listForPresentation` and **no controller exposes it**.

So this proposal is really two pieces of work, and the second is the larger:

| | Work |
|---|---|
| **API** | Tenant-scoped, paginated list endpoints for services, intended uses, policies, presentations, issuances and issued credentials; an audit route; cursor pagination; and a decision per endpoint about what a list item may contain — which for presentations means **metadata only, never result content** |
| **Console** | Forms, tables, a status poller, a server-side QR renderer, a cookie session |

That ordering matters for estimating, and it is also an argument for doing A first: **the test driver
needs none of it.** It uses `POST /v1/presentations` and `GET /v1/presentations/{id}`, both of which
exist.

> A list endpoint is not a neutral addition. `GET /v1/presentations` returning an array of
> transaction metadata is a new data-exposure decision — it makes enumeration possible where previously a
> caller had to hold an id — and it needs the tenant-isolation tests extended to cover enumeration, not
> just direct access. That is exactly the kind of thing that gets waved through when a UI is waiting for
> it, which is why it is called out here rather than discovered in review.

## 6. Phasing and effort

Rough, and deliberately coarse — the second number is the one that will move.

| Phase | Content | Effort | Unblocks |
|---|---|---|---|
| **A1** | Test driver: policy picker, start, QR + link, poller, result panel, run-record output | **~1 day** | The VaaS run sheet, immediately |
| **A2** | The public test-start page, if same-device testing is wanted | ~0.5 day | Same-device on a phone |
| **B1** | List endpoints + audit route + pagination + isolation tests for enumeration | **~2–3 days** | Everything in B2 |
| **B2** | Console: the eight screens, cookie session, BFF actions | ~2–3 days | Operating without `curl` |
| **C** | Customer portal | **Not estimated.** Needs its own discovery | — |

A1 and A2 are throwaway by design and should be labelled as such in their own README, so nobody later
mistakes a test harness for a product surface.

## 7. Non-goals, stated so they do not creep in

- **No customer-facing portal** (product C), and no screens that imply one.
- **No "raw response" or "debug" view**, ever — §3.1.
- **No second source of truth.** The console stores nothing of its own: no users table, no cached
  transactions, no saved policy drafts. It has a config file and a session cookie.
- **No EUDIPLO contracts on screen.** `CLAUDE.md` §3.1 and §3.3: no DCQL, no engine session ids, no
  credential offers, no engine configuration objects. If a screen needs one, the platform model is
  missing something — fix that instead.
- **No production-readiness claim**, in the UI chrome or anywhere else. The console shows the
  `trustEnvironment` (`TEST`) prominently, for the same reason the test wallet shows a banner.
- **No authentication system.** A single operator session from a configured credential. Multi-user with
  roles is product C.

## 8. What I need decided

1. **A only, A then B, or all three?** My recommendation: **A1 now, A2 if same-device testing is
   wanted, and B only when `curl` has actually become the bottleneck** — which it has not yet, because
   the M2 work was done with scripts and contract tests rather than by hand.
2. **Does the test driver need the public page (A2)**, or is QR-on-the-laptop enough for the first runs?
   `SAME_DEVICE` is the tested default per ADR 0009, which argues for A2 — but the first run could be QR
   to keep the gateway out of it.
3. **Which branch.** This proposal touches nothing, so it can sit on its own branch; A1 should not go
   into the issuance PR.

If A1 is approved I would build it against the existing two endpoints and nothing else, so it stays a
day of work and adds no API surface.
