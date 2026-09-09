# PuB-EAA Managed Service

**Decision:** **AMBER** — technically feasible only with the public-sector provider's retained authority, identity and assessed controls.

**Status:** [REGULATORY] / [IMPLEMENTING-ACT] / [SPECIFICATION] / [PRODUCT-HYPOTHESIS] / [OPEN]

## Non-negotiable provider boundary

`[REGULATORY]` Under eIDAS Article 3(46), the legal/ecosystem provider is either (a) the public-sector body responsible for the Authentic Source or (b) another **public-sector body designated by the Member State** to issue for responsible public bodies. “On behalf of” in the PuB-EAA name is this statutory public-body designation. It is not a general permission for a private platform to become the provider.

`[REGULATORY]` Article 45f and Annex VII bind the attestation to the issuing public body's qualified signature or seal and certificate. The issuer certificate must state its responsible-source or designated-on-behalf status and identify the Authentic Source. The public body must be notified by its Member State with a conformity-assessment report and appear through the Commission publication mechanism.

| Axis | Required model |
|---|---|
| Legal Attestation Provider | `[REGULATORY]` Eligible and notified public-sector body |
| Authentic Source | `[REGULATORY]` Source for which the provider is responsible, or source of the represented responsible body where the provider is designated |
| Technical operator | `[PRODUCT-HYPOTHESIS]` Platform under documented delegation and public-body control |
| Cryptographic identity | `[REGULATORY]` Issuing public-sector body identified by Annex VII and Article 45f certificate attributes |
| Key operator | `[OPEN]` Public body (K1) or an accepted qualified/assessed remote arrangement (K2/K4); never a platform-wide private identity (K3) |
| Trust actors | `[REGULATORY]` Member State, CAB, qualified-certificate/QSCD actors and Commission provider list; `[SPECIFICATION]` PuB-EAA Provider LoTE |

## Meaning of managed service

`[PRODUCT-HYPOTHESIS]` The platform may offer source connectors, policy execution, approvals, claim mapping, generation, OpenID4VCI, status machinery and audit as technical controls. The public body must retain effective governance: approve the scheme and credential type; authorise source access and purposes; own/approve eligibility rules; control issuance and revocation authority; control use of its identity/key; supervise the operator; receive evidence/incidents; and exercise termination/portability.

`[OPEN]` Neither eIDAS nor Regulation 2025/1569 expressly settles private subcontracting of the complete stack. Before production, obtain national legal validation and CAB/certificate-policy confirmation that the particular delegation, HSM/QSCD arrangement, audit access and public-body controls preserve compliance.

## End-to-end journey and allocation

The category in the final column is the primary classification requested; “Platform” always means technical execution, not provider authority.

| Step | Flow | Allocation | Evidence/condition |
|---:|---|---|---|
| 1 | Citizen requests PuB-EAA | **SHARED** — customer defines service/terms; platform presents journey | `[SPECIFICATION]` ARF 3.0 issuance model; `[OPEN]` sector eligibility and legal basis |
| 2 | Platform initiates issuance | **PLATFORM RESPONSIBILITY** under provider-authorised profile | `[PRODUCT-HYPOTHESIS]` Versioned transaction and delegation evidence |
| 3 | Issuer flow requests PID/prerequisite attestations | **SHARED** | `[SPECIFICATION]` The requesting issuer also acts as wallet-relying party for the presentation leg; RP registration/access controls apply separately |
| 4 | Wallet identifies requester | **REGULATORY ACTOR** — Wallet Unit validates RP access/registration artefacts | `[IMPLEMENTING-ACT]` Regulations 2024/2982 and 2025/848; if an intermediary is used, both identities must be represented |
| 5 | User approves presentation | **REGULATORY ACTOR** — user/Wallet Unit | `[REGULATORY]` Wallet control and data-minimisation rules; `[SPECIFICATION]` ARF 6.6.3.5 notes approval is not itself a GDPR legal basis |
| 6 | Platform validates presentation | **PLATFORM RESPONSIBILITY**, provider accountable | `[PRODUCT-HYPOTHESIS]` Protocol, trust, nonce, status and policy evidence retained minimally |
| 7 | Platform queries Authentic Source | **SHARED** — source responds, provider authorises, platform connects | `[REGULATORY]` Source remains authoritative; `[OPEN]` national access and data-role conditions |
| 8 | Eligibility/business rules run | **SHARED** by Delegation Profile | `[PRODUCT-HYPOTHESIS]` Public body owns/approves policy; platform may execute attributable rules |
| 9 | PuB-EAA is generated | **PLATFORM RESPONSIBILITY**, provider accountable | `[IMPLEMENTING-ACT]` Required format, scheme and Annex VII content validated before signing |
| 10 | Correct provider identity signs/seals | **CUSTOMER RESPONSIBILITY** for authority; technical operation may be shared | `[REGULATORY]` Issuing public body's qualified signature/seal; `[IMPLEMENTING-ACT]` QSCD controls; K2/K4 remain `[OPEN]` pending acceptance |
| 11 | OpenID4VCI delivery to Wallet | **PLATFORM RESPONSIBILITY**, provider accountable | `[IMPLEMENTING-ACT]` Provider authenticates with valid access certificate and validates Wallet Unit; `[SPECIFICATION]` current profile |
| 12 | Status/lifecycle managed | **SHARED**, with non-delegable provider authority | `[IMPLEMENTING-ACT]` Only issuing provider may revoke; >24-hour attestations have mandatory triggers; privacy-preserving status required |

## RP leg is separate from issuer trust

`[REGULATORY]` RP trust answers who requests the citizen's PID/attributes. Issuer trust answers who issued the PuB-EAA. An RPAC or RPRC does not designate a PuB-EAA Provider, confer source authority, satisfy Article 45f notification, or authorise use of the provider signing identity.

`[SPECIFICATION]` A public body may register its service and run one or more RP Instances. `[OPEN]` A platform-hosted instance could use per-body material where national registrar/CA policy permits. If the platform is instead an Article 5b(10) intermediary, it is deemed a relying party; ARF 3.11.4 requires the relationship to be registered and the Wallet to identify both intermediary and intermediated public body.

See [RP registration and access](../06-shared-capabilities/rp-registration-and-access.md).

## Release gates

- `[OPEN]` Written determination that the public body is eligible under Article 3(46), including the exact Authentic Source relationship.
- `[OPEN]` Member-State notification route and CAB assessment scope, including all platform-operated controls.
- `[OPEN]` Qualified certificate profile includes the Article 45f attributes; QSCD and K1/K2/K4 model accepted by issuer, CA/QTSP and CAB.
- `[OPEN]` Provider-only revocation authority is enforced even where platform automation executes the action.
- `[OPEN]` RP model classified as hosted RP Instance or registered intermediary, with correct Wallet display and per-tenant keys.
- `[OPEN]` National public law, procurement, secrecy, GDPR controller/processor, location, incident, audit, subcontracting and exit requirements approved.

## Sources

- [eIDAS consolidated, Articles 3(46)-(47), 45b, 45f and Annex VII](https://eur-lex.europa.eu/eli/reg/2014/910)
- [Implementing Regulation 2025/1569, current consolidated text](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02025R1569-20260811)
- [ARF 3.0 roles, sections 3.5, 3.7, 3.10 and 3.11](https://eudi.dev/3.0.0/main/03-roles-within-the-eudi-wallet-ecosystem/)
- [ARF 3.0 trust model](https://eudi.dev/3.0.0/main/06-trust-model/)
