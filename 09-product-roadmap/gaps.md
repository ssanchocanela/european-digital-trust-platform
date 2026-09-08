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
| Delegated legal roles | Technical execution may not identify the legal Attestation Provider | Separate EAA, PuB-EAA and QEAA role/liability analysis for each model | 1–2 |
| Policy governance | Platform decisions need versioning, authorship, explanation and appeal controls | Policy model and decision-record spike; no engine selection yet | 1–2 |
| Authentic Source connectivity | Source authority, provenance, freshness and outages affect every decision | Source contracts, connector threat model and failure/reconciliation tests | 1–2 |
| Hybrid workflow semantics | Customer/platform hand-offs can create ambiguity and stuck transactions | Delegation Profile combinations, deadlines, evidence and recovery model | 2 |

`[OPEN]` Every row requires validation before the affected production decision.
