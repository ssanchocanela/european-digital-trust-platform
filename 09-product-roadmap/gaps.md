# Gaps and Validation Backlog

| Gap | Why it matters | Evidence needed | Target phase |
|---|---|---|---|
| ARF 3.0 feature-to-code traceability | README-level support is insufficient | Pinned RI/EUDIPLO releases, tests and TS mapping | 1 |
| Authoritative trust onboarding | Protocol engines cannot grant scheme participation | Registrar, LoTE, certificate and notification procedures per environment | 1–2 |
| Stable customer API | EUDIPLO APIs may evolve with protocol releases | Consumer journeys, canonical model, compatibility policy | 2 |
| Production assurance | Open source and conformance are not operational assurance | Threat model, pen test, SBOM, HA/DR, SLO and incident model | 2–3 |
| Mandate semantics | Representation has legal and national dependencies | Authentic sources, revocation, delegation and cross-border rules | 2–4 |
| EUBW final requirements | Current Commission text is proposed regulation | Legislative tracking and delta analysis | Continuous |
| Qualified-service boundary | QES/QSeal/QERDS require qualified providers and legal controls | QTSP architecture, liability and evidence contracts | 2–4 |
| DPP delegated requirements | Data varies by product group and legislation | Delegated acts, schemas, identifier and access rules | 2–5 |
| DPP Registry integration | Current user workflow does not prove a stable public API | Official interface/auth/versioning documentation | 2–5 |
| DPP hosting/resolution | Registry holds identifiers/metadata, not full data | Hosting, availability, sovereignty and resolver architecture | 3–5 |
| Privacy/retention | Issuance and verification can expose personal data | DPIA inputs, minimization, deletion and audit policies | Every phase |
| Portability/exit | Protocol engine lock-in would undermine reusable service design | Adapter contract tests and alternate-engine spike | 2 |
| Delegated legal roles | Analysis bounds the roles but regulatory silence does not approve a concrete outsourcing arrangement | National/scheme legal opinion and contract/control review for each Provider Operating Profile | 1–2 |
| PuB-EAA managed operation | Private platform cannot be statutory “on behalf” provider; technical delegation remains unsettled | Article 3(46) eligibility, national authority, CAB scope, notification/list proof and public-body retained-control assessment | 1–2 |
| PuB-EAA signing/key operation | Public-body qualified identity and QSCD are required; K2/K4 operation needs acceptance | Qualified certificate profile, CA/QTSP policy, QSCD evidence and CAB/national approval | 1–2 |
| QEAA/QTSP boundary | Platform orchestration cannot replace a listed QTSP or qualified-service controls | QTSP partner/deployment design, CAB/supervisor acceptance, K4 boundary, API and evidence contract | 2–3 |
| RP hosting versus intermediary | Wallet display, registration and Article 5b(10) no-storage duties differ | Registrar/legal classification, data-flow assessment and public-body/intermediary registration proof | 1–2 |
| RPAC/RPRC delegated key management | Acts define identity/scope but do not grant general third-party key-hosting permission | Member-State registration policy, CA CPS, per-tenant HSM design and authority evidence | 1–2 |
| Implementing-act transition | IR 2025/848 applies from 24 Dec 2026 and amended verification duties have deferred dates | Applicability calendar, production service readiness and migration/conformance tests | Continuous |
| Policy governance | Platform decisions need versioning, authorship, explanation and appeal controls | Policy model and decision-record spike; no engine selection yet | 1–2 |
| Authentic Source connectivity | Source authority, provenance, freshness and outages affect every decision | Source contracts, connector threat model and failure/reconciliation tests | 1–2 |
| Hybrid workflow semantics | Customer/platform hand-offs can create ambiguity and stuck transactions | Delegation Profile combinations, deadlines, evidence and recovery model | 2 |

`[OPEN]` Every row requires validation before the affected production decision.
