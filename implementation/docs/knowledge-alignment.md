# Knowledge alignment

Where an implementation decision conflicts with, or is not covered by, an existing page in this
repository's knowledge documentation.

Per the implementation rules, the existing knowledge documentation is **not restructured and not
edited silently**. Each item below records the conflict and proposes a change for separate review.

---

## KA-1 — The verification-side knowledge pages do not exist

**Pages:** `05-eudi-services/verification-operating-models.md`,
`05-eudi-services/presentation-policy.md`, `05-eudi-services/verifier-product-model.md`,
`06-shared-capabilities/presentation-privacy-and-retention.md`,
`08-architecture/verification-service-architecture.md`, `09-product-roadmap/verification-mvp.md`
— all **absent**.

**Conflict.** Milestone 1 is the verification milestone, and its core concepts —
`PresentationPolicy`, `PresentationPolicyVersion`, `VerificationPlan`, the result policy, the
presentation transaction state machine, the hosted-RP-Instance operating profile — have no
knowledge page to align with. The issuance side, by contrast, has eight pages including a full
product model and service architecture. The knowledge base is asymmetric and the asymmetry is on
the wrong side for M1.

**Decision: backlog, not this PR.** Confirmed at the Phase 0 checkpoint — the pages are **not**
created in the implementation PR. They are a knowledge-base change and must not be smuggled in under
an implementation branch where a reviewer looking at code would not expect them.

### Backlog

Each page as a separate, reviewable change against `main`, mirroring the structure and `[STATUS]`
tagging of its issuance counterpart. Content already exists in the Phase 0 findings and ADRs 0002–0005 and 0009.

| Page | Counterpart to mirror | Source material |
|---|---|---|
| `05-eudi-services/verification-operating-models.md` | `attestation-provider-operating-models.md` | Findings §5.1, §6.2; ADR 0009 |
| `05-eudi-services/presentation-policy.md` | — (new concept) | ADR 0005; `docs/api/verification-api.md` |
| `05-eudi-services/verifier-product-model.md` | `issuer-product-model.md` | Findings §3.6; `packages/domain/src/kernel` |
| `06-shared-capabilities/presentation-privacy-and-retention.md` | — (new) | ADR 0004; `docs/privacy.md` |
| `08-architecture/verification-service-architecture.md` | `issuance-service-architecture.md` | `docs/architecture.md` |
| `09-product-roadmap/verification-mvp.md` | `issuance-mvp.md` | Findings §6; `docs/reference-wallet-testing.md` §9 |

A seventh, smaller item: a PID attribute reference, per KA-7.

---

## KA-2 — The intermediary display requirement is stated backwards

**Page:** [`06-shared-capabilities/rp-registration-and-access.md`](../../06-shared-capabilities/rp-registration-and-access.md),
section "Public body with a platform-operated endpoint", pattern 2, and the row
"What does Wallet display?" in "Answers to the delegation hypothesis".

**What it says.** "ARF 3.11.4 requires the intermediary relationship to be registered and the
Wallet to identify both the intermediary and intermediated RP", and that the Wallet "must not
misleadingly show only the public body when the platform is a separate intermediary", and
"if intermediary, both RP and intermediary identities".

**What ARF 3.0.0 says.** `AS-RP-52-008` (`RPI_07`): "In case a Wallet Unit receives a presentation
request from an intermediary on behalf of an intermediated Relying Party, it **SHALL NOT display
the trade names of the intermediary and the intermediary Service** to the User when asking for
User approval, as described in `RPA_07`." The approval screen shows the intermediated Relying Party
only.

The registration half of the page's claim is correct — `AS-RP-52-001` (`RPI_01`),
`AS-RP-52-003` (`RPI_03`) and `AS-RP-52-004` (`RPI_04`) do require the relationship to be
registered with legally valid evidence, and TS5 v1.5 carries `usesIntermediaries`, `isIntermediary`
and `servedWRPServices` for exactly that. It is the **display** claim that is inverted. Note also
the TS5 v1.5 observation that `isIntermediary` is **not** mapped into the access or registration
certificate attributes in ETSI TS 119 475, so it is verifiable only through the Registrar's API —
which is the opposite of the transparency the page assumes.

**Proposal.** Amend the two statements to: the relationship must be registered and evidenced, and
`RPI_07` requires the approval screen to show the intermediated Relying Party and its Service, not
the intermediary. Keep the page's underlying caution — that a platform "cannot use 'on behalf' to
disappear from the interaction" remains true **legally** (Article 5b(10) deems the intermediary a
relying party, and `RPI_08`/`RPI_10` impose forwarding and immediate-deletion duties) even though
it is not shown to the user at approval time. That distinction strengthens the page's argument
rather than weakening it.

**Delivery: a separate small PR against `main`.** Decided at the Phase 0 checkpoint. It is a
correction to a knowledge page, not an implementation change, and bundling a one-paragraph factual
fix into a 120-file implementation PR would bury it. The implementation PR records the finding here
and changes nothing in that page.

**Impact on V0.** None directly — V0 does not implement the intermediary profile. But the page is
the main input to the hosted-instance-vs-intermediary question (KA-3), so the error should not
propagate into that decision.

---

## KA-3 — The legal qualification of the hosted-RP-Instance profile is unresolved

**Pages:** [`06-shared-capabilities/rp-registration-and-access.md`](../../06-shared-capabilities/rp-registration-and-access.md)
and [`09-product-roadmap/gaps.md`](../../09-product-roadmap/gaps.md) rows "RP hosting versus
intermediary" and "RPAC/RPRC delegated key management".

**Record, as the implementation prompt requires.** V0 operates as a **hosted Relying Party
Instance**: the platform operates the Instance on behalf of the Relying Party using the Relying
Party's own access and registration certificates. V0 does **not** implement the Article 5b(10)
intermediary profile.

**The legal qualification of that profile — processor versus intermediary — needs legal
confirmation.** The existing page already reaches this conclusion and lists the determining facts
(whose service is delivered, who determines purpose and means, who receives presentation data, who
controls the endpoint and the key, whether the platform forwards content as a distinct actor) and
correctly declines to "select the less visible label". Phase 0 adds two technical facts that bear
on it:

1. **Key custody is unavoidable in the V0 architecture.** EUDIPLO holds the access-certificate
   private key in its own key chain (database-encrypted, or Vault / AWS KMS / PKCS#11). Whether a
   third party may host a Relying Party's access-certificate key is recorded as `OPEN` on that page
   and is not settled by the binding acts. The platform must therefore require per-tenant,
   non-exportable keys and Access CA acceptance, exactly as the page's product controls say.
2. **Registration is per Service, and identifiers are not platform-owned.** `Reg_32` gives the
   entity one EU-wide unique identifier; `Reg_33` makes the Service identifier the registering
   entity's choice; EUDIPLO derives `rpId` from the tenant's registrar relying party and will not
   accept a per-request override. So the architecture structurally prevents a shared platform RP
   identity — which is the page's "Separate identities per tenant? **Yes**" control, enforced by
   construction rather than by policy.

**Proposal.** No page change. The record required by the prompt is made here; ADR 0006 is reserved
for the decision and is **blocked on legal input** (open question Q2). Obtain registrar,
data-protection and legal confirmation before any `PRODUCTION` `trustEnvironment` is enabled.

---

## KA-4 — Tenant identity in the path versus in the token

**Page:** [`05-eudi-services/api-concepts.md`](../../05-eudi-services/api-concepts.md), contract
principles: "Tenant identity comes from authenticated context, never a caller-controlled body
field."

**Tension.** The V0 business API places `{tenantId}` in the path
(`POST /v1/tenants/{tenantId}/presentation-policies`, and so on).

**Resolution, no conflict.** The page forbids *deriving* tenancy from caller-supplied input, not
*expressing* it in a URL. The implementation rule is: the tenant is derived from the authenticated
API key; a `tenantId` appearing in a path or body is **validated against** the derived tenant and
rejected on mismatch, never used as the source of truth. This is also what the implementation
prompt says. Cross-tenant access tests will assert the rejection.

**Proposal.** No page change. Recorded so the path-style URLs are not later read as a departure
from the principle.

---

## KA-5 — The page's API shape is issuance-first and resource names differ

**Page:** [`05-eudi-services/api-concepts.md`](../../05-eudi-services/api-concepts.md) illustrates
`POST /v1/credentials` and `POST /v1/issuance-transactions`, and explicitly says these examples
"do not freeze paths, schemas or transport style".

**Divergence.** V0 uses `POST /v1/presentations` (M1) and `POST /v1/issuances` (M2), plus
`POST /v1/issued-credentials/{id}/revoke`. The page's `Delegation Profile` concept does not appear
in the V0 issuance model, which uses `IssuancePolicy` / `IssuancePolicyVersion` with an
`AuthenticSourceConnector` port and an `EligibilityEvaluator` interface instead.

**Assessment.** Within the latitude the page grants itself. The V0 model is a deliberate narrowing:
`IssuancePolicyVersion` covers what a `Delegation Profile` would assign in a Model B
("Managed Issuance") configuration only, which is the single service model V0 implements. The page's
richer Model A / B / C and Delegation Profile concepts remain the target and are not contradicted.

**Proposal.** No page change now. When M2 lands, add a short mapping table to
`implementation/docs/api/issuance-api.md` showing `IssuancePolicyVersion` as the V0 realisation of a
platform-executed Delegation Profile, so the relationship is explicit rather than implied.

---

## KA-6 — `eudiplo-assessment.md` records a pre-release commit

**Page:** [`05-eudi-services/eudiplo-assessment.md`](../../05-eudi-services/eudiplo-assessment.md),
header: "Code inspected: `openwallet-foundation/eudiplo` `main` at `1885065b54797a9eb4a9deffeeaef11380071477`".

**Finding.** That commit is the OID4VCI caching and federation-trust deduplication change
(PR #998 / issue #834) that shipped in release **v7.6.0** on 2026-09-08 — one day after the
assessment date of 7 September 2026. The assessment was therefore made against unreleased `main`,
not against a release.

**Assessment.** The assessment's conclusions hold — Phase 0 re-verified the capability map against
released `v7.6.0` and found them accurate, including the `WRAP` verdict and the six adoption gates.
Its adoption gate 1 ("Pin a release and map every used feature to ARF 3.0, applicable technical
specifications and implementing acts") is precisely what Phase 0 began.

**Proposal.** When the page is next revised, state the pinned release (`v7.6.0`, digest
`sha256:8dd60a2f…`) alongside the commit, so the reader can tell release-based evidence from
`main`-based evidence. Minor; no conclusion changes.

---

## KA-7 — ARF version drift has invalidated a premise, not a page

**Pages:** none of this repository's pages assert it, but the implementation prompt's §6.4 does, and
a reader may reasonably expect the knowledge base to cover it.

**Finding.** `age_over_18` / `age_over_NN` are **no longer PID attributes**. PID Rulebook v1.1
(4 Sep 2025) change log: "Age verification attributes removed, following CIR 2024/2977." The
complete current attribute set contains no age attribute, and the live reference PID issuer
advertises none. See [`phase-0-findings.md`](phase-0-findings.md) §6.3 and
[`interop-findings.md`](interop-findings.md) C6.

**Assessment.** The knowledge base is not wrong here — it simply does not cover PID attribute-level
content, because no page does. That is itself a small gap: a reader looking for "which PID
attributes can we ask for" has nowhere to look, and the absence is how a stale assumption survived
into the implementation prompt.

**Proposal.** Add a short PID attribute reference to
[`06-shared-capabilities/credentials.md`](../../06-shared-capabilities/credentials.md) or to the
new `presentation-policy.md` from KA-1, citing the Rulebook repository and document version rather
than the ARF version — since the Rulebook now moves independently of the ARF (see
[`interop-findings.md`](interop-findings.md) D2). Separate change; not done in Phase 0.

---

## KA-8 — `gaps.md` rows that Phase 0 sharpened

No conflict; recorded so the gap register can be updated in a later, separate change.

| `gaps.md` row | What Phase 0 added |
|---|---|
| ARF 3.0 feature-to-code traceability | The traceability unit cannot be "ARF 3.0.0 / TSn": the TS and Rulebook repositories are untagged. Use *(HLR id, TS internal version, commit SHA)*. See [`interop-findings.md`](interop-findings.md) D1, D2 |
| Authoritative trust onboarding | Quantified: the dev WRPAC LoTE holds exactly 7 EUDIW Access CA anchors, and EUDIPLO's only shipped registrar preset is not among them. Blockers B1 and B2 |
| Portability / exit | The adapter boundary is concrete: `OfferResponse {uri, crossDeviceUri, session}`, the `SessionOutcome` failure taxonomy, and `POST /session/revoke` are the only engine contracts the platform depends on |
| Privacy / retention | Quantified: `SESSION_TTL` default 86400 s, `SESSION_CLEANUP_MODE` default `full`, hourly tidy-up, and the specific entity fields that hold content. See ADR 0004 |
| Policy governance | `IntendedUse.purpose` and `privacyPolicy` are localised multi-valued per TS5 v1.5 and are displayed to the user per `RPA_10`, so policy text is user-facing and needs localisation governance, not just versioning |
