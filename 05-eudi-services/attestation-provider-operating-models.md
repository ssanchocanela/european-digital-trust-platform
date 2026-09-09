# Attestation Provider Operating Models

**Decision date:** 9 September 2026

**Scope:** EAA, PuB-EAA and QEAA Issuance as a Service

**Status:** [REGULATORY] / [IMPLEMENTING-ACT] / [SPECIFICATION] / [PRODUCT-HYPOTHESIS] / [OPEN]

This is product-architecture decision support, not legal advice. A conclusion marked `[OPEN]` is a release gate, not implied permission.

## Questions tested

- **Q1.** Can our platform technically issue an EAA on behalf of another provider?
- **Q2.** Can our platform execute eligibility/business rules while another entity remains the Attestation Provider?
- **Q3.** For PuB-EAA, what precisely must remain with the Public Sector Body?
- **Q4.** Can we operate the PuB-EAA technical issuer completely on behalf of the Public Sector Body?
- **Q5.** Can RPAC/RPRC and RP registration be managed technically by our platform while representing the Public Sector Body to the Wallet?
- **Q6.** Whose identity must the Wallet see when PID is requested as part of a PuB-EAA issuance journey?
- **Q7.** Whose cryptographic identity signs a PuB-EAA?
- **Q8.** Who may operate the corresponding private keys?
- **Q9.** For QEAA, which responsibilities MUST remain with the QTSP?
- **Q10.** Can our platform provide orchestration/business logic around a QTSP qualified issuance service?
- **Q11.** Which of Gateway / Managed / Hybrid are viable for EAA, PuB-EAA and QEAA?
- **Q12.** What unresolved questions require formal legal or Member State validation?

## Evidence method and temporal boundary

The order used is: eIDAS Regulation; implementing acts; ARF 3.0; official topics/rulebooks/technical specifications; official Reference Implementation (RI); EUDIPLO. `[INFERENCE]` RI and EUDIPLO demonstrate implementation choices only; they cannot establish that legal responsibility or a regulated role may be outsourced.

The analysis uses the [consolidated eIDAS text](https://eur-lex.europa.eu/eli/reg/2014/910), [Implementing Regulation 2025/1569 consolidated at 11 August 2026](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02025R1569-20260811), [Implementing Regulation 2026/1731](https://eur-lex.europa.eu/eli/reg_impl/2026/1731/oj/eng), [Implementing Regulation 2024/2982](https://eur-lex.europa.eu/eli/reg_impl/2024/2982/oj/eng), and [Implementing Regulation 2025/848](https://eur-lex.europa.eu/eli/reg_impl/2025/848/oj/eng). `[IMPLEMENTING-ACT]` Regulation 2025/848 is adopted but applies only from **24 December 2026**; designs may target it, but must not describe all of its duties as currently applicable on the decision date.

`[SPECIFICATION]` ARF 3.0 is an architecture/specification source, not legislation. Where it simplifies Article 3(46) by saying a PuB-EAA Provider issues “on behalf of” a public body, the Regulation's narrower definition controls.

## Vocabulary of certainty

| Phrase | Meaning in this analysis |
|---|---|
| Explicitly required | A cited binding provision uses a duty or prerequisite. |
| Explicitly permitted | A cited binding provision positively enables the arrangement. |
| Explicitly prohibited | A cited binding provision excludes the arrangement. |
| Technically possible | A specification or implementation demonstrates mechanics, not legal permission. |
| Not specified | The reviewed primary sources do not allocate the matter. |
| Our interpretation | A labelled inference connects cited requirements to a product decision. |

## Role model: identity, operation and authority are separate axes

| Role | Regulatory/ecosystem meaning | May be separate? |
|---|---|---|
| Authentic Source | `[REGULATORY]` Article 3(47): a public- or private-sector repository/system, held under the responsible entity, that contains/provides attributes and is primary or recognised as authentic under Union/national law or administrative practice. | `[REGULATORY]` Yes. Article 45e expressly contemplates a QEAA provider verifying attributes against an Authentic Source or recognised intermediary. |
| Attestation Provider | `[REGULATORY]` The entity providing the trust service or the public-sector issuer recognised for the regime. It owns the issuance decision and resulting provider obligations. | `[INFERENCE]` It need not operate every software component, but delegation is not a transfer of the provider role. |
| Technical Issuance Service Provider | `[PRODUCT-HYPOTHESIS]` A processor/operator supplying connectors, policy execution, credential generation, protocol, status and audit under another provider's authority. | `[OPEN]` Not a defined eIDAS role. Contract, national law, security, data-protection and conformity constraints must be validated. |
| Trust/registration actor | `[REGULATORY]` Supervisory body, CAB, Member State, national trusted-list body or PuB notifier; `[SPECIFICATION]` Registrar, Access CA, registration-certificate provider or LoTE provider. | `[REGULATORY]` Yes; these actors establish or publish trust rather than issue the user's attestation. |
| Wallet Provider / Wallet Unit | `[REGULATORY]` The provider supplies the wallet solution; the user controls the unique Wallet Unit. | `[SPECIFICATION]` The Attestation Provider validates the Wallet Unit and issues to it through the prescribed interface. |

`[INFERENCE]` Each deployment record must independently identify (1) legal Attestation Provider, (2) technical operator, (3) cryptographic identity represented, and (4) private-key operator. Matching two fields never proves that all four are the same entity.

## Regime findings

### Non-qualified EAA

- `[REGULATORY]` Issuing an EAA is a trust service; the provider is a trust service provider under Articles 3(16), 3(19) and 3(44). It may be a natural or legal person and need not be a QTSP. Article 45b prevents denial of legal effect solely because the attestation is electronic or non-qualified; it does not give the paper-equivalence accorded to QEAA/PuB-EAA.
- `[REGULATORY]` The provider remains subject to the general trust-service security, supervision and liability framework, including Articles 13, 19 and 46b, and the EAA-specific data separation in Article 45h(1)-(2). A non-qualified provider does not gain qualified status or Article 22 qualified-list treatment.
- `[SPECIFICATION]` ARF 3.0 sections 3.8, 3.15 and 6.6 model a non-qualified EAA Provider, Attestation Rulebook/scheme, provider access/registration material, Wallet Unit validation and OpenID4VCI issuance. ARF says non-qualified-provider trusted lists may exist but are outside its scope; therefore the governing scheme must define its trust path.
- `[IMPLEMENTING-ACT]` Implementing Regulation 2024/2982 Article 4 requires a Wallet Unit to request issuance only from a party with a valid provider access certificate for the claimed entitlement. `[SPECIFICATION]` ARF 3.0 additionally models provider registration certificates and checks the registered attestation types, with the deferred applicability it records for the amended rule.
- `[REGULATORY]` No general rule makes an Authentic Source mandatory for every ordinary EAA. `[INFERENCE]` Source authority, scheme membership, signature/seal profile, status and lifecycle are controlled by applicable law, sector rules and the Attestation Scheme; absence of a qualified/public regime is not absence of obligations.
- `[OPEN]` The reviewed sources do not expressly permit or prohibit outsourcing an ordinary EAA issuer stack. A platform may technically execute under another provider's identity, but provider responsibility, scheme acceptance, data roles, key controls and audit rights require contractual and legal validation.
- `[PRODUCT-HYPOTHESIS]` Platform-side eligibility and business rules are compatible with a customer remaining provider only if the customer owns/approves the policy, the scheme permits the control model, decisions are attributable and appealable, and the provider can supervise, override and evidence operation.

### PuB-EAA

- `[REGULATORY]` Article 3(46) is decisive: the issuer is either the public-sector body responsible for the Authentic Source **or another public-sector body designated by the Member State** to issue on behalf of responsible public bodies. A private SaaS operator cannot become the PuB-EAA Provider merely through a bilateral delegation contract.
- `[REGULATORY]` Article 45f and Annex VII require the issuer to be unambiguously represented and the PuB-EAA to carry the qualified electronic signature or qualified electronic seal of that issuing public-sector body. The supporting qualified certificate must identify whether it is responsible for the Authentic Source or designated to act on its behalf and must represent the source.
- `[REGULATORY]` The Member State must notify the provider with a CAB conformity-assessment report; `[IMPLEMENTING-ACT]` Regulation 2025/1569 Articles 5-6 makes the Commission's signed/sealed provider list the publication mechanism. The legal provider, not the platform brand, must occupy this trust position.
- `[IMPLEMENTING-ACT]` Regulation 2025/1569 Articles 3-4 requires the provider to follow the referenced ETSI/specification baseline, applicable registered scheme, provider-only revocation authority, mandatory revocation circumstances for validity over 24 hours, privacy-preserving revocation, and authentic/integrity-protected status information.
- `[IMPLEMENTING-ACT]` The same Regulation's Annex I requires a qualified signature/seal creation device for the EAA signature/seal and lifecycle security controls for other service keys. `[INFERENCE]` A generic cloud KMS claim is insufficient evidence of compliance.
- `[SPECIFICATION]` ARF 3.0 sections 3.5, 3.7 and 6.6 verifies the signature against the PuB-EAA Provider LoTE and expects the provider to authenticate to, and validate, the Wallet Unit.
- `[OPEN]` EU sources do not fully allocate private subcontracting of connectors, rules, generation, OpenID4VCI, HSM operation, status publishing or incident response. Technical delegation is plausible, but national public-law authority, procurement/data rules, certificate policy, conformity assessment and retained effective control require case-by-case approval.

### QEAA

- `[REGULATORY]` Articles 3(45), 20-24 and 45d plus Annex V require a QEAA to be issued by a QTSP, for the qualified service to have qualified status, and for the issuing QTSP's qualified signature/seal and identity to appear in the attestation. The service may begin only after qualified status is in the Article 22 national trusted list.
- `[REGULATORY]` The QTSP must retain the qualified-service governance: subject identity/attribute verification under Article 24, service policies, conformity and audits, supervisory relationship, qualified provider identity, approval of issuance, qualified signing/sealing, status/revocation authority, evidence, incidents/termination and regulatory liability. A supplier can perform controls, but cannot replace the QTSP in those duties by contract.
- `[REGULATORY]` Article 45h(3) requires the qualified EAA service to be functionally separate from the QTSP's other services; Article 45h(1)-(2) requires personal-data non-combination and logical separation.
- `[IMPLEMENTING-ACT]` Regulation 2025/1569 applies the same provider-only revocation, scheme, cryptographic-device, Wallet-authentication and technical-format controls described above. Article 9 establishes verified source-access mechanisms for Annex VI attributes, with the requesting QTSP acting on a legitimate user's request.
- `[PRODUCT-HYPOTHESIS]` **Platform for QTSP** is viable when deployed/licensed as QTSP-controlled technology with the regulated boundary, evidence and keys accepted in the QTSP's conformity assessment.
- `[PRODUCT-HYPOTHESIS]` **Partner offering** is viable when the platform performs customer/source integration and prepares an authenticated, evidence-rich issuance request, while the QTSP verifies/accepts it, makes the qualified issuance decision, signs/seals as provider, issues or authoritatively controls issuance, and controls status/revocation.
- `[OPEN]` Exact reliance on platform-performed identity, source and eligibility checks must be accepted by the QTSP, CAB and supervisory body. Article 24(1a) permits identity verification by an appropriate third party, but does not transfer provider responsibility.

## Signing and key architecture

“Valid” means supported in principle; it does not replace scheme, certificate-policy or conformity approval.

| Key model | EAA | PuB-EAA | QEAA |
|---|---|---|---|
| **K1 Customer-controlled** — platform calls customer HSM/KMS | **POTENTIALLY VALID** `[OPEN]` if provider identity, scheme profile and operational control are satisfied. | **POTENTIALLY VALID** `[REGULATORY]` only under the issuing public body's identity, qualified certificate and required QSCD; `[OPEN]` integration/control acceptance. | **POTENTIALLY VALID** `[OPEN]` only where “customer” is the QTSP and the qualified-service/QSCD boundary is assessed and controlled by it. |
| **K2 Platform-operated dedicated customer key** — isolated tenant partition, customer identity | **POTENTIALLY VALID** `[INFERENCE]` if the EAA provider authorises and controls use and the scheme accepts the custody model. | **OPEN** `[IMPLEMENTING-ACT]` provider identity and QSCD are mandatory; whether platform operation preserves required public-body control depends on national law, certificate/QSCD policy and CAB assessment. | **OPEN** `[REGULATORY]` only inside the QTSP's assessed qualified-service controls; platform custody outside that boundary is not sufficient. |
| **K3 Platform provider key** — platform identity | **VALID** `[REGULATORY]` only when the platform itself is the EAA trust service provider; **NOT PERMITTED** as a way to claim another provider's identity. | **NOT PERMITTED** `[REGULATORY]` when it represents the private platform rather than the Article 3(46) public-sector issuer. | **NOT PERMITTED** `[REGULATORY]` unless the platform legal entity and service are themselves qualified and listed as the QEAA QTSP. |
| **K4 QTSP-controlled qualified operation** | **POTENTIALLY VALID** `[INFERENCE]`; stronger machinery does not turn an EAA into a QEAA unless all qualified requirements/status apply. | **POTENTIALLY VALID** `[OPEN]` where the result remains the qualified signature/seal of the public-sector issuer and remote operation is legally/certifiably structured. | **VALID / REQUIRED BOUNDARY** `[REGULATORY]` the issuing QTSP must control the qualified operation and identity; exact local/remote architecture is implementation-specific. |

`[INFERENCE]` Multi-tenancy requires separate provider identity, authorization policy, audit boundary and cryptographic partition per legal provider. A platform-wide issuer key is not an acceptable shortcut for customer-provider PuB-EAA or QEAA.

## Product operating-model decision matrix

| Model | EAA | PuB-EAA | QEAA |
|---|---|---|---|
| **Gateway** | **GREEN** `[INFERENCE]` Customer is legal provider/source-policy owner; platform generates/delivers under customer identity using K1/K2; scheme registrar/trust actor validates customer. | **GREEN/AMBER** `[INFERENCE]` Public body is legal provider/source authority, platform is protocol operator, public-body identity and K1/K4 (or approved K2) sign; notification, approval, revocation authority and liability remain public body. | **GREEN** `[PRODUCT-HYPOTHESIS]` QTSP is provider/trusted-list subject/key authority; platform accepts approved data and orchestrates QTSP-controlled issuance. |
| **Managed** | **AMBER** `[OPEN]` Customer remains provider while platform runs connectors/rules/approval/status under supervised Delegation Profile; platform may instead be provider only if it assumes the full trust-service role and identity. | **AMBER** `[OPEN]` Public body remains provider and source authority; platform may run the stack only with retained public-body control, compliant identity/QSCD, assessed delegation, provider-only revocation authority and national approval. It can never privately self-designate. | **RED** if platform/customer purports to issue; **AMBER** `[PRODUCT-HYPOTHESIS]` only as a managed technology service inside a QTSP-controlled, assessed qualified-service boundary. |
| **Hybrid** | **GREEN/AMBER** `[INFERENCE]` Customer is provider and allocates source/rules/approval/lifecycle execution; trust identity and residual provider duties remain explicit. | **AMBER** `[OPEN]` Likely preferred: public body owns source, policy and final authority; platform executes selected controls; identities, keys, notification and revocation authority remain regime-correct. | **GREEN/AMBER** `[PRODUCT-HYPOTHESIS]` Platform integrates customer/source/workflow; QTSP retains qualified decisions, identity, signing, trust-list, status and liability. |

The cell colour never applies without the stated actor configuration. `[INFERENCE]` “Managed” describes operational breadth, not legal-role transfer.

## Responsibility matrices

Codes: **A** accountable/provider decision; **R** executes; **C** consulted/control input; **I** informed; **RA** regulatory/trust actor. Multiple `R` entries mean the Delegation Profile must choose or sequence execution. All platform allocations below are `[PRODUCT-HYPOTHESIS]`; retained-accountability allocations derive from the regime findings above.

### EAA — customer remains non-qualified EAA Provider

| Capability | Customer/provider | Platform | Authentic Source | Trust/RA |
|---|---|---|---|---|
| Scheme definition | A/C | C | C | R/A scheme owner |
| Source ownership | C | I | A/R | I |
| Connector / retrieval | A/R | R | C/R | I |
| Eligibility / business rules / approval | A/R | R | C | I |
| User identification / PID presentation | A | R | I | Registrar/Access CA RA |
| RP registration / RPAC / RPRC | A | R | I | Registrar/CAs RA |
| Credential generation / signing / key custody | A | R K1/K2 | I | Scheme trust actor C |
| OpenID4VCI | A | R | I | Access/registration CA C |
| Issuer registration / notification / trust | A/R | C/R automation | I | Registrar/supervisor/scheme RA |
| Status / revocation / renewal | A/R | R | C | Scheme/supervisor C |
| Audit / incident / liability | A | R/C | C | Supervisor RA |

### PuB-EAA

| Capability | Public-body provider | Platform | Authentic Source | Trust/RA |
|---|---|---|---|---|
| Scheme definition | A/C | C | C | Scheme owner/Commission RA |
| Source ownership | A when responsible body | I | R (may equal provider) | Member State C |
| Connector / retrieval | A | R | C/R | I |
| Eligibility / business rules / approval | A/R | R | C | CAB C |
| User identification / PID presentation | A as RP or intermediated RP | R as hosted instance or registered intermediary | I | Registrar/Access CA RA |
| RP registration / RPAC / RPRC | A | R automation/C | I | Registrar/CAs RA |
| Credential generation | A | R | I | CAB C |
| Signing / key custody | A; public-body identity | R only approved K2 or orchestration | I | Qualified CA/QSCD/QTSP/CAB RA |
| OpenID4VCI | A | R | I | Access/registration CA C |
| Provider notification / LoTE | A/R evidence | C/R workflow | C | Member State/Commission/CAB RA |
| Status / revocation / renewal | A/R; only provider has authority | R under authorised control | C | Commission list/CAB C |
| Audit / incident / liability | A | R/C | C | CAB/Member State/supervisor RA |

### QEAA

| Capability | Customer/source owner | Platform | QTSP/provider | Trust/RA |
|---|---|---|---|---|
| Scheme definition | C | C | A/C | Scheme owner/Commission RA |
| Source ownership | A/R or external AS | I | C | National source mechanism RA |
| Connector / retrieval | C | R | A/C/verify | Authentic Source R |
| Eligibility / business rules | C | R | A/accept | CAB C |
| User identification / PID presentation | I/C | R | A | Registrar/Access CA RA |
| RP registration / RPAC / RPRC | I | R automation/C | A as requesting provider/RP | Registrar/CAs RA |
| Approval / credential generation | C | R prepare | A/R qualified decision | CAB C |
| Signing / key custody | I | C/orchestrate | A/R K4 | QSCD/CAB/supervisor RA |
| OpenID4VCI | I | R technical | A/control | Access/registration CA C |
| Provider notification / trusted list | I | C | A/R | CAB/supervisor/TL body RA |
| Status / revocation / renewal | C/request | R support | A/R; only provider authority | TL/supervisor C |
| Audit / incident / liability | C | R/C evidence and incident support | A | CAB/supervisor RA |

## Architecture consequence

`[PRODUCT-HYPOTHESIS]` Use an Attestation Provider Adapter selected by a versioned Provider Operating Profile. It is useful because it makes regime-specific trust, signing, registration, decision authority and status controls explicit while leaving source/policy/workflow components reusable. It must not flatten all regimes into a generic `sign()` API.

The adapter and end-to-end design are specified in [attestation provider architecture](../08-architecture/attestation-provider-architecture.md). Detailed boundaries are in [PuB-EAA managed service](pubeaa-managed-service.md), [QEAA/QTSP model](qeaa-qtsp-model.md), [RP registration and access](../06-shared-capabilities/rp-registration-and-access.md), and [issuer trust and registration](../06-shared-capabilities/issuer-trust-and-registration.md).

## Explicit answers

1. **Q1 — Yes, technically; legally conditional.** `[OPEN]` The platform can execute ordinary EAA issuance under another provider's controlled identity, but sources do not expressly approve outsourcing or transfer provider responsibility.
2. **Q2 — Yes, conditionally.** `[PRODUCT-HYPOTHESIS]` Platform rules are compatible with another provider only with provider-owned policy, supervision, evidence, override and scheme/legal acceptance.
3. **Q3 — Provider status and identity stay public.** `[REGULATORY]` The Article 3(46) eligible public body, relationship to the Authentic Source, notified/listed status, provider identity, qualified signature/seal, issuance and revocation authority, conformity evidence and liability cannot be replaced by a private platform.
4. **Q4 — Technically broad operation is possible; “completely on behalf” is not established.** `[OPEN]` Public-body retained authority/control and national/CAB/certificate-policy approval prevent treating it as turnkey legal delegation.
5. **Q5 — Automation is possible, identity substitution is not.** `[SPECIFICATION]` A platform may operate a public body's RP Instance and lifecycle automation if accepted. If it is a legal intermediary, Article 5b(10)/ARF 3.11.4 treat it as a relying party and the wallet must also identify it. Hosted key use remains `[OPEN]` under CA policy and national law.
6. **Q6 — The actual registered requester(s).** `[REGULATORY]` The wallet must see the public body when it is the RP; where a separate intermediary is used, it must see both the intermediated public body and intermediary. A platform must not masquerade as the body.
7. **Q7 — The issuing public-sector body.** `[REGULATORY]` Annex VII and Article 45f require its qualified signature or seal and unambiguous issuer identity.
8. **Q8 — No universal outsourcing answer.** `[OPEN]` K1 is clearest; K2/K4 may be possible inside compliant QSCD/certificate and public-body-control arrangements; K3 under the private platform identity is incompatible.
9. **Q9 — The regulated qualified boundary.** `[REGULATORY]` QTSP identity/status, qualified decision and service control, verification responsibility, signing/sealing, keys/QSCD boundary, trust-list entry, status/revocation authority, conformity, supervision, audit/incident/termination and liability remain with the QTSP.
10. **Q10 — Yes.** `[PRODUCT-HYPOTHESIS]` Orchestration and business logic may surround a QTSP API, provided the QTSP verifies/accepts evidence and retains the qualified-service decisions and controls.
11. **Q11 — Gateway:** green for EAA/QEAA and green-amber for PuB-EAA. **Managed:** amber for EAA/PuB-EAA, red if the platform claims QEAA provider status but amber inside a QTSP boundary. **Hybrid:** green-amber across regimes and the preferred regulated model. `[INFERENCE]`
12. **Q12 — Formal validation remains material.** `[OPEN]` Validate national PuB delegation/public-law authority; CAB acceptance of outsourced controls; QSCD, qualified-certificate and remote-key policy; per-tenant RPAC/RPRC private-key hosting; whether the platform is merely a hosted RP Instance or Article 5b(10) intermediary; EAA scheme/trust/status rules; GDPR controller/processor allocation; incident/liability/insurance; and production registrar, Commission-list and catalogue procedures.

## Primary and implementation sources

- [eIDAS Regulation 910/2014, consolidated](https://eur-lex.europa.eu/eli/reg/2014/910)
- [Regulation 2024/1183 amending eIDAS](https://eur-lex.europa.eu/eli/reg/2024/1183/oj/eng)
- [Implementing Regulation 2025/1569, consolidated 11 August 2026](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02025R1569-20260811)
- [Implementing Regulation 2026/1735](https://eur-lex.europa.eu/eli/reg_impl/2026/1735/oj/eng)
- [Implementing Regulation 2024/2982](https://eur-lex.europa.eu/eli/reg_impl/2024/2982/oj/eng) and [2026/1731 amendment](https://eur-lex.europa.eu/eli/reg_impl/2026/1731/oj/eng)
- [Implementing Regulation 2025/848](https://eur-lex.europa.eu/eli/reg_impl/2025/848/oj/eng)
- [ARF 3.0 roles](https://eudi.dev/3.0.0/main/03-roles-within-the-eudi-wallet-ecosystem/) and [trust model](https://eudi.dev/3.0.0/main/06-trust-model/)
- [ARF Technical Specification 5](https://eudi.dev/3.0.0/technical-specifications/ts5-common-formats-and-api-for-rp-registration-information/) and [Technical Specification 6](https://eudi.dev/3.0.0/technical-specifications/ts6-common-set-of-rp-information-to-be-registered/)
- `[IMPLEMENTATION-EVIDENCE]` [Official RP Registration Service RI](https://docs.eudi.dev/latest/build/supporting-ecosystem-services/rp-registration-service/) and [official RI organisation](https://github.com/eu-digital-identity-wallet)
- `[IMPLEMENTATION-EVIDENCE]` [EUDIPLO](https://github.com/openwallet-foundation/eudiplo), used only as protocol/feasibility evidence
