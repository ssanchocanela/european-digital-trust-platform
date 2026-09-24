# ADR 0001 — Platform technology

- **Status:** DRAFT (Phase 0), awaiting approval
- **Date:** 11 September 2026
- **Deciders:** to be confirmed by the user at the Phase 0 checkpoint

## Context

The implementation prompt proposes a default stack and asks it to be confirmed or challenged:
Node.js 22 LTS, TypeScript, NestJS, PostgreSQL, Docker Compose, pnpm workspaces, with a database
migration tool mandatory.

Constraints that bear on the choice:

- EUDIPLO v7.6.0 is itself TypeScript / NestJS / TypeORM, and publishes a generated SDK
  (`@eudiplo/sdk-core`, versioned in lockstep with the release).
- The platform is a modular monolith for V0 ([ADR 0003](0003-modular-monolith.md)) wrapping a
  replaceable engine ([ADR 0002](0002-eudiplo-as-wrapped-engine.md)).
- V0 must run from `docker compose up` with PostgreSQL and a pinned EUDIPLO image.
- EUDIPLO supports PostgreSQL and documents it as the production option; SQLite is its default but
  is not ours.

## Decision

**Confirm the proposed stack**, with the following specifics and one explicit refusal.

| Concern | Decision |
|---|---|
| Runtime | Node.js 22 LTS |
| Language | TypeScript, `strict` |
| Framework | NestJS |
| Database | PostgreSQL, in a database **separate from EUDIPLO's** |
| Migrations | A real migration tool, mandatory; migrations are explicit files, never schema auto-sync |
| Monorepo | pnpm workspaces |
| Local environment | Docker Compose: `platform-api`, `postgres` (platform), `postgres-eudiplo`, `eudiplo` |
| EUDIPLO image | `ghcr.io/openwallet-foundation/eudiplo:7.6.0` @ `sha256:8dd60a2fe38f7c6f91b6a3c4003182fbb1a3659a5a7a697166ad0f0c5120c667` |
| EUDIPLO admin client | **Not** in the platform's Compose file. It is an operator tool, and the prompt requires the EUDIPLO admin surface not be exposed beyond localhost |
| HTTP client to EUDIPLO | Hand-written, typed, inside the adapter package — **not** `@eudiplo/sdk-core`. See below |
| API documentation | OpenAPI generated from the NestJS decorators |
| Validation | Schema-first at the boundary; every input validated |
| Tests | Unit and integration suites separated, with the EUDIPLO-container suite independently skippable |

### Why a separate migration tool rather than TypeORM synchronise

Not negotiable, and EUDIPLO supplies the cautionary evidence: v7.3.0 shipped a fix described as
adding "the session columns that no migration ever created" (closing issue #894). An ORM that can
create schema implicitly will eventually be allowed to. The platform sets the equivalent of
`synchronize: false` permanently and tests `migrate-up-from-empty` as a first-class integration
test, as the prompt's §8.4 requires.

### Why not use `@eudiplo/sdk-core`

The SDK is generated from EUDIPLO's schemas and versioned with EUDIPLO. Depending on it would put
EUDIPLO types in the platform's dependency graph and make every EUDIPLO release a potential
compile-time event — which is precisely the coupling the anti-corruption layer exists to prevent,
and exactly the risk profile observed in §4.10 of the findings (six releases in 27 days, a
CommonJS→ESM migration between two of them).

Instead the adapter package owns a small, hand-written typed client covering only the endpoints the
platform actually calls. Verified at v7.6.0, those are:

```
POST   /api/oauth2/token                            (client credentials)
POST   /verifier/config                             (create presentation configuration)
PATCH  /verifier/config/:id                         (update)
DELETE /verifier/config/:id
POST   /verifier/offer                              (create presentation request)
GET    /session/:id                                 (poll result)
DELETE /session/:id                                 (cancel)
PUT    /session-config                              (retention, per ADR 0004)
POST   /key-chain/import                            (import an access certificate P12)
GET    /health
```

Milestone 2 adds `POST /issuer/credentials`, `POST /issuer/config`, `POST /issuer/offer` and
`POST /session/revoke`. That is a small enough surface that hand-writing it costs less than the
coupling, and it makes the contract explicit enough to test. `@eudiplo/sdk-core` may still be used
as a **reference** for request and response shapes.

### Challenge considered and rejected: a non-Node platform

Choosing a different language would strengthen the "replaceable engine" story by making accidental
coupling impossible. Rejected for V0: it doubles the toolchain, loses the ability to read EUDIPLO's
source as the authoritative API contract (which §4 of the findings shows is necessary, because the
documentation diverges from the code in at least seven places), and buys isolation that the port
and adapter boundary already provides by design. The coupling risk is addressed by not importing
EUDIPLO's SDK, not by changing language.

## Consequences

- **Positive.** One language across platform and engine, so EUDIPLO's source is directly readable as
  the contract of record. NestJS gives dependency injection boundaries that make the ports
  substitutable and the adapter testable against a fake. PostgreSQL in both databases keeps the
  operational surface small.
- **Negative.** Shared-language convenience makes accidental leakage of EUDIPLO concepts into
  platform types easy. Mitigation: EUDIPLO types exist only inside `packages/eudiplo-adapter`, and a
  CI check asserts that no other package imports from it or mentions EUDIPLO identifiers.
- **Negative.** Two PostgreSQL instances in Compose increase local resource use. Accepted: a single
  shared database would undermine the separation the prompt requires in §3.3 and would let a future
  change read EUDIPLO's session table directly — which, given §4.7, would be reading stored
  personal data.
- **Operational.** Pinning by digest means EUDIPLO upgrades are deliberate, reviewed changes with
  adapter contract tests as the gate.

## Open

- Database migration tool not yet selected between the obvious candidates; any of them satisfies the
  requirement, so the choice is deferred to the first Milestone 1 commit rather than asserted here.
- Node 22 LTS support window versus the V0 timeline is not assessed.

## Status of claims

This ADR claims no conformance with ARF 3.0.0 or any Technical Specification, and no production
readiness.
