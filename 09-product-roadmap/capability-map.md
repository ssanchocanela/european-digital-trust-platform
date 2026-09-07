# Capability Map

**Snapshot:** 7 September 2026. “Support” means evidence exists in current documentation/code; it does not mean certified, complete or production-ready.

| Domain | Capability | Source | Status | Official EUDI RI support | EUDIPLO support | Platform requirement | Implementation approach | Priority | Open questions |
|---|---|---|---|---|---|---|---|---|---|
| EUDI Wallet | Wallet app/core | RI, ARF 3.0 | SPECIFICATION / EXPERIMENTAL | Yes, Android/iOS apps and core kits | No | Interoperate; avoid proprietary wallet | Reuse RI and test | P0 | Target OS/releases and certification impact? |
| Issuer | Credential issuance | ARF, OID4VCI 1.0 | SPECIFICATION | Test/demo services and libraries | Yes | Simple managed API | Wrap EUDIPLO; benchmark RI | P0 | Exact profile/flow matrix? |
| Issuer | Credential lifecycle/status | ARF, OAuth Status List | SPECIFICATION / PRODUCT | Component-specific | JWT/CWT status lists | Authority, revocation policy, evidence | Extend engine and lifecycle service | P0 | Legal retention and status SLAs? |
| Verifier | Remote presentation | ARF, OID4VP 1.0 | SPECIFICATION | Yes | Yes, DCQL | Normalized verified result | Wrap EUDIPLO | P0 | Transaction data and policy profiles? |
| Verifier | Browser wallet invocation | ARF Topic F, DC API | SPECIFICATION / EVOLVING | Libraries/examples | OID4VP and ISO 18013-7 paths | Browser SDK and fallback | Extend/wrap | P1 | Browser/platform support matrix? |
| Verifier | Proximity presentation | ISO 18013-5, ARF | SPECIFICATION | Yes | Server focus; mdoc validation | Optional channel | Reuse RI reader where needed | P2 | Initial customers require proximity? |
| Trust Infrastructure | Trust-list/LoTE resolution | ARF 3.0/TS | SPECIFICATION | Incremental wallet-side support | ETSI LoTE/trust list parsing | Governed, cached, observable resolution | Extend behind interface | P0 | Authoritative sources and failure policy? |
| Trust Infrastructure | Access certificates | ARF/technical specifications | SPECIFICATION | Relevant RI paths | Certificate/registrar workflows | RP/issuer onboarding and renewal | Extend/integrate registrar | P0 | Production registrar availability? |
| Trust Infrastructure | Registration certificates | ARF/technical specifications | SPECIFICATION | Relevant RI paths | Import/generate/use workflows | Intended-use enforcement | Extend and validate | P0 | Who issues and validates in each scheme? |
| Trust Infrastructure | OpenID Federation | OpenID Federation + profile choices | SPECIFICATION / OPEN | Component-dependent | Extension implemented | Optional trust method | Isolate behind resolver | P2 | Is it selected by target schemes? |
| Business Wallet | Organisation workspace | EC EUBW proposal | PROPOSED-REGULATORY / PRODUCT | No | No | Core track 1 product | Build | P1 | Proposal changes and minimum mandated scope? |
| Business Wallet | Organisation identity | EUBW proposal; national/EU sources | PROPOSED-REGULATORY | No | Generic credentials only | Onboard and authenticate organisations | Build/integrate authentic sources | P1 | Authoritative identifiers and cross-border model? |
| Mandates | Roles and representation | EUBW proposal; ARF topics | PROPOSED-REGULATORY / OPEN | Partial natural-person concepts | No mandate authority | Delegation, scope, time, revocation | Build adapters and policy | P1 | Legal effect and authoritative sources? |
| QES/QSeal | Qualified signing/sealing | eIDAS as amended | REGULATORY | RQES-related modules | Not a QTSP | Orchestrate qualified services | Wrap QTSP; reuse RI UX selectively | P1 | Remote/local model and provider portability? |
| QERDS | Qualified registered delivery | eIDAS as amended | REGULATORY | No complete service | No | Legally valid communications | Integrate qualified provider | P2 | Qualification/liability model? |
| eDelivery | AS4 messaging/discovery | EC eDelivery specs | SPECIFICATION | No | No | Optional interoperable transport | Reuse conformant AP/SMP product | P2 | Network/domain and AS4 1.x/2.0 needs? |
| DPP | Portfolio and lifecycle | ESPR/delegated acts + product hypothesis | REGULATORY / PRODUCT / OPEN | No | No | Major Business Wallet module | Build domain service | P1 | Product-group delegated acts and schemas? |
| DPP Registry | Organisation enrolment and registration | EC Registry material | SPECIFICATION | No | No | Register identifiers/metadata | Build registry adapter | P1 | Stable production API and auth model? |
| DPP Hosting | Complete DPP data | ESPR/DPP system | REGULATORY / PRODUCT | No | No | Provider-neutral data layer | Build abstraction/connectors | P1 | Availability, sovereignty and resolver rules? |
| Audit | Evidence and traceability | eIDAS/ARF/product policies | MIXED | Wallet transaction history scope | Admin audit/session events | Purpose-limited, tamper-evident evidence | Build shared service | P0 | Retention, data minimization, admissibility? |
| Administration | Multi-tenant control plane | Product requirements | PRODUCT | No | Tenant/client/config APIs and UI | Delegated admin, quotas, operations | Extend or build around engine | P0 | Isolation and data-residency tiers? |
| API Gateway | Stable business APIs | Product requirements | PRODUCT | No | Protocol/admin REST APIs | Versioned customer contracts | Build anti-corruption layer | P0 | Sync/async contract and error model? |
| Security | Keys, secrets and signing | ARF/eIDAS/threat model | REGULATORY / SPECIFICATION / PRODUCT | Wallet secure-component paths | Local/cloud/PKCS#11 KMS options | Custody policy, HSM/KMS, rotation | Wrap providers; independent controls | P0 | Assurance levels and qualified boundaries? |
| Security | Privacy and tenant isolation | GDPR, ARF, platform threat model | REGULATORY / PRODUCT | Wallet privacy features | Controls/tests exist | Minimize data; hard tenancy boundary | Verify, extend and continuously test | P0 | Session/claim retention per service? |

See [reuse strategy](../08-architecture/reuse-strategy.md) for classifications and [gaps](gaps.md) for validation work.
