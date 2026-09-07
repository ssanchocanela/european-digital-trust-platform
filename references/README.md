# Evidence Policy and Research Snapshot

Research snapshot: **7 September 2026**. Web sources and moving codebases must be rechecked before an architecture decision or procurement.

## Source precedence

1. Adopted EU legislation and applicable implementing/delegated acts.
2. The versioned ARF and its normative high-level requirements and technical specifications.
3. Official Commission documentation and official EUDI Reference Implementation repositories.
4. EUDIPLO documentation and code, pinned to a release or commit.
5. Explicit product hypotheses.

Claims derived from layers 4–5 cannot establish legal compliance. Repository names, roadmaps and README statements are leads, not proof of implemented capability; important reuse decisions must be verified against code, tests, release notes and interoperability results.

## Citation practice

Use direct links close to claims. Record a version, release, commit or access date when the source changes over time. Never copy substantial external text. When evidence is incomplete, use `[OPEN] Requires validation.`

## Decision vocabulary

- `REUSE`: adopt a component substantially as provided.
- `EXTEND`: add capability through supported extension points or a maintained fork.
- `WRAP`: isolate it behind a platform-owned interface.
- `REFERENCE`: use its design/tests as guidance, not runtime code.
- `REPLACE`: plan a different component because the fit is inadequate.
- `NOT REQUIRED`: outside the target capability.

The current assessment is in [reuse strategy](../08-architecture/reuse-strategy.md).
