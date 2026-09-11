# European Digital Trust Platform — V0

Platform foundations and **Verification as a Service**. Milestone 1.

**V0 is not production-ready, and no ARF or Technical Specification conformance is claimed.** The
shortcuts are enumerated in [`docs/security-limitations.md`](docs/security-limitations.md) and the
honest status of every requirement is in [`docs/traceability.md`](docs/traceability.md).

---

## What it does

A business application asks the platform to obtain evidence from an EUDI Wallet. It works with
**presentation policies and transactions** — never with DCQL, OpenID4VP, credential offers or
protocol engine configuration. The protocol lives below a platform-owned port, behind which
EUDIPLO v7.6.0 is wrapped as a replaceable engine.

The V0 flagship policy requests a PID date of birth and returns `{ "over_18": true }`. The date of
birth never reaches the customer and is never stored.

## Quick start

```bash
cp .env.example .env      # fill in every CHANGE-ME
docker compose up
```

Starts the platform API (`127.0.0.1:3100`), its PostgreSQL, a **separate** PostgreSQL for the
engine, and EUDIPLO pinned by digest. Migrations run at startup. OpenAPI at
`http://localhost:3100/openapi`.

Then walk the whole configuration chain and create a presentation:

```bash
PLATFORM_ADMIN_API_KEY=<your-admin-key> ./scripts/smoke-vaas.sh
```

## Development

```bash
pnpm install
pnpm verify     # lint + typecheck + boundary check + unit + integration
```

`pnpm verify` needs no Docker and no external service: the integration suite boots an **embedded
PostgreSQL**.

| Command | What it does |
|---|---|
| `pnpm build` | Compile every package and the app |
| `pnpm test` | Unit tests (133) — pure logic, always runnable |
| `pnpm test:integration` | Integration tests (66) — real PostgreSQL, real repositories and services, fake verifier port |
| `pnpm test:adapter` | Adapter contract tests — **skipped** unless an engine container is reachable |
| `pnpm boundaries` | Fails if the engine leaks outside `packages/eudiplo-adapter` |
| `pnpm db:generate` | Regenerate the migration SQL from the schema |

To run the adapter suite against a real engine:

```bash
docker compose up -d eudiplo
ENGINE_BASE_URL=http://localhost:3000 \
  ENGINE_TENANT_CREDENTIALS='root=root:your-secret' \
  pnpm test:adapter
```

## Layout

```
implementation/
├── apps/platform-api/          the only deployable; HTTP, auth, composition root
├── packages/
│   ├── shared/                 ids, errors, clock, result, localised text, log redaction
│   ├── domain/                 shared kernel + verification module
│   ├── eudi-verifier-port/     interface and platform types only
│   ├── eudi-issuer-port/       interface only in Milestone 1
│   ├── persistence/            Drizzle schema, repositories, checked-in SQL migrations
│   └── eudiplo-adapter/        the only package that knows the engine exists
├── tests/{unit,integration,adapter,support}
├── scripts/
├── docs/
└── docker-compose.yml
```

## Documentation

| | |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Shape, engine boundary, request flow, state machine, data classes |
| [`docs/api/verification-api.md`](docs/api/verification-api.md) | The business API, with the claim-path rules and callback verification |
| [`docs/privacy.md`](docs/privacy.md) | What is stored, what is not, and the `OIA_16` basis for it |
| [`docs/security-limitations.md`](docs/security-limitations.md) | Every V0 shortcut, and what closing it takes |
| [`docs/eudiplo-integration.md`](docs/eudiplo-integration.md) | The exact engine contract, verified against its source |
| [`docs/reference-wallet-testing.md`](docs/reference-wallet-testing.md) | How to attempt a wallet test, and what blocks it |
| [`docs/traceability.md`](docs/traceability.md) | Behaviour → ARF HLR → specification, with honest status |
| [`docs/phase-0-findings.md`](docs/phase-0-findings.md) | The investigation: blockers, open questions, decisions |
| [`docs/interop-findings.md`](docs/interop-findings.md) | Divergences between implementations and the specification |
| [`docs/knowledge-alignment.md`](docs/knowledge-alignment.md) | Conflicts with the repository's knowledge base |
| [`docs/adr/`](docs/adr/) | 0001 technology · 0002 engine + tenant mapping · 0003 modular monolith · 0004 ephemeral processing · 0005 policy + minimisation |
| [`CLAUDE.md`](CLAUDE.md) | Rules that must persist across working sessions |

## Five things that are easy to get wrong

Each contradicts a plausible assumption. All are load-bearing.

1. **`age_over_18` is not a PID attribute.** PID Rulebook v1.1 removed the age-verification
   attributes following CIR 2024/2977, and the live reference issuer advertises none. An age check
   over a PID must derive from the date of birth. ADR 0005 Decision 5.
2. **Requested claims are OpenID4VP claim *paths*,** not flat attribute names, and the subset check
   is a path-subset check: extending a registered path is allowed, prefixing it is not.
3. **One engine tenant per Relying Party Instance,** not per platform tenant — the engine scopes key
   material per tenant while ARF scopes it per Service. ADR 0002 Decision 3.
4. **Never branch on the engine's session status.** `failed` covers trust, signature and protocol
   failures alike. Branch on the failure code.
5. **`SAME_DEVICE` is the tested path.** ARF discourages redirect-based cross-device flows
   (`OIA_08c`) and obliges mitigations if used (`OIA_08d`), which V0 has not implemented, so `QR`
   is present but flagged.

## The one thing V0 cannot do

**No interaction with an official EUDI Reference Implementation wallet build has been
demonstrated.** The wallet enables only the `X509SanDns` and `X509Hash` client-id schemes, always
enforces access-certificate trust, and accepts only seven EUDIW-operated Access CA anchors. A
self-signed certificate cannot work and there is no preregistered escape hatch in the shipped
build.

Milestone 1 therefore targets a **self-built** Reference Implementation wallet trusting a
platform-operated development Access CA — approved at the Phase 0 checkpoint. That is a *modified*
wallet, it is labelled as such everywhere, and the official-build result remains **unverified**.
[`docs/reference-wallet-testing.md`](docs/reference-wallet-testing.md) has the evidence, both paths
and the manual steps.
