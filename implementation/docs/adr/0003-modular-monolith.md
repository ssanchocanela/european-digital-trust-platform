# ADR 0003 — Modular monolith

- **Status:** DRAFT (Phase 0), awaiting approval
- **Date:** 11 September 2026

## Context

The platform spans several bounded contexts — tenancy and organisations, relying-party registration
and trust material, presentation policy, presentation transactions, and later attestation providers,
credential types, issuance policy and issuance transactions. The implementation prompt's §7 is
explicit: "Don't over-engineer V0. Modular monolith; bounded contexts are modules, not services."

The deployment already contains two processes the platform does not own the lifecycle of (EUDIPLO and
its PostgreSQL), so the operational surface is not zero even in the simplest design.

## Decision

**One deployable application, `apps/platform-api`. Bounded contexts are modules inside packages, not
services.**

```
implementation/
├── apps/
│   └── platform-api/              # the only deployable; HTTP, auth, composition root
├── packages/
│   ├── shared/                    # primitives, errors, ids, clock, result types
│   ├── domain/                    # shared kernel + verification module + issuance module (M2)
│   ├── persistence/               # repositories, migrations, mapping
│   ├── eudi-verifier-port/        # interface + platform types only
│   ├── eudi-issuer-port/          # interface only in M1
│   └── eudiplo-adapter/           # the only package that knows EUDIPLO exists
└── docs/
```

### Module boundaries inside `packages/domain`

| Module | Owns |
|---|---|
| `shared-kernel` | `Tenant`, `Organisation`, `RelyingParty`, `RelyingPartyService`, `IntendedUse`, `RegistrationCertificate`, `AccessCertificate`/`KeyBinding`, `RelyingPartyInstance`, `trustEnvironment`, and the generic policy-versioning machinery (draft → published → retired, published versions immutable) |
| `verification` | `PresentationPolicy`, `PresentationPolicyVersion`, `PresentationPolicyCompiler`, `VerificationPlan`, `PresentationTransaction` and its state machine, result policies, `TrustResolver` result normalisation |
| `issuance` (M2) | `AttestationProvider`, `CredentialType`, `IssuancePolicy`/`Version`, `AuthenticSourceConnector`, `EligibilityEvaluator`, `IssuanceTransaction`, `IssuedCredentialRecord` |

The shared kernel is built **in Milestone 1 so that issuance can reuse it**, as the prompt's §5
requires. Concretely, the generic policy-versioning machinery is written once against
`PresentationPolicyVersion` and reused by `IssuancePolicyVersion` without change, and
`AttestationProvider` exists in M1 as types only.

### Rules that make the boundaries real

1. **Dependencies point inward.** `domain` depends on `shared` only. `persistence`, the ports and
   the adapter depend on `domain`. `apps/platform-api` depends on everything and is the only
   composition root. No cycles; enforced in CI.
2. **No module reaches into another module's tables.** Cross-module reads go through the owning
   module's interface. This is the constraint that makes a later extraction cheap, and the one that
   erodes first without a check.
3. **`eudiplo-adapter` is the only package that may mention EUDIPLO.** Asserted in CI (see
   [ADR 0002](0002-eudiplo-as-wrapped-engine.md)).
4. **Data classes are separated in code and storage**, per the prompt's §8.1: configuration,
   transaction metadata, ephemeral content, derived result, audit evidence. In the schema this means
   separate tables with separate lifecycles, not columns on one row — which is also what makes the
   "content is never persisted" claim in [ADR 0004](0004-ephemeral-presentation-and-issuance-processing.md)
   checkable rather than aspirational.
5. **One database, one migration history.** Modules share the platform PostgreSQL database but not
   each other's tables. A table is named for its owning module.

### What V0 deliberately does not do

- No services, no message broker, no event bus between modules. In-process calls and, where
  decoupling genuinely helps (webhook delivery, retention jobs), a database-backed queue.
- No CQRS, no event sourcing. `PresentationTransaction` keeps an explicit, table-driven state
  machine and an append-only transition log — which satisfies the audit requirement without an
  event-sourcing framework.
- No plugin system for result transformations or eligibility rules. The prompt is explicit that
  these are "a small explicit transformation interface (no expression/rules engine)" and
  "a small explicit interface, no rules engine". Honoured literally: TypeScript interfaces with
  named implementations registered at startup. This is also consistent with
  [`05-eudi-services/issuer-product-model.md`](../../../05-eudi-services/issuer-product-model.md),
  which records that policy-engine technology is `[OPEN]` and that no rules engine is selected.
- No multi-region, no read replicas, no horizontal-scaling work.

### Challenge considered: separate verification and issuance services

Rejected for V0. The two share the whole shared kernel — tenancy, organisations, registration, trust
material, policy versioning — so splitting them would duplicate that kernel or require a synchronous
dependency between services on every request. It would also pre-commit the service boundary before
the domain has been exercised once. The prompt's instruction is explicit and the reasoning holds.

## Consequences

- **Positive.** One process to run, one database, one migration history, one deployment. Milestone 1
  can be delivered and reviewed without distributed-systems work.
- **Positive.** Extraction stays available: the module boundary plus the "no cross-module table
  access" rule is what a later split needs, and building it now costs almost nothing.
- **Negative.** Module boundaries inside one process decay silently. Mitigated by CI dependency
  checks rather than review discipline.
- **Negative.** No independent scaling of issuance versus verification. Irrelevant at V0 volumes.
- **Negative.** A database-backed queue is less capable than a broker for webhook retries. Accepted;
  the prompt's §6.8 requires exponential backoff with a bounded attempt count and per-event
  idempotency, all of which a table provides.

## Status of claims

No conformance with ARF 3.0.0 or any Technical Specification is claimed. No production readiness is
claimed; the prompt's §8.3 states plainly that V0 is not production-ready, and this ADR does not
change that.
