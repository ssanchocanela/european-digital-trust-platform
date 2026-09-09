# Issuer Onboarding

**Status:** [PRODUCT] / [OPEN]

Issuer onboarding creates a usable, isolated issuing context; it is distinct from relying-party onboarding and from a technical protocol session.

## Proposed onboarding flow

1. Establish the Tenant, Organisation, administrators and separation-of-duties roles.
2. Select EAA, PuB-EAA or QEAA and record the legal Attestation Provider, technical operator, cryptographic identity, key operator, jurisdictions and Attestation Scheme in a Provider Operating Profile.
3. Configure one or more Authentic Sources and their Connectors, including data purpose and permitted attributes.
4. Define the Credential Type and supported Credential Configurations/formats.
5. Define mappings, Eligibility, Approval, Validity and Lifecycle Policies.
6. Select and approve a Delegation Profile for every lifecycle step.
7. Configure K1-K4 signing/key custody, status, trust, issuer metadata and RP/provider registration/access certificates without conflating those artefacts with legal provider status.
8. Validate connectivity without retaining unnecessary source data.
9. Run negative, lifecycle, conformance and official EUDI Reference Wallet interoperability tests.
10. Approve environment promotion with an immutable configuration/version record and current external-authority evidence.

## Regime gates

- `[REGULATORY]` **EAA:** identify the non-qualified trust service provider and applicable sector/scheme trust, signature and status rules.
- `[REGULATORY]` **PuB-EAA:** prove Article 3(46) public-body eligibility/source relationship, CAB report, Member-State notification, Commission-list state, qualified public-body signature/seal and provider-only revocation control.
- `[REGULATORY]` **QEAA:** bind an Article 22-listed QTSP and qualified QEAA service, QTSP-controlled approval/signing/status boundary, conformity and supervisory evidence.
- `[OPEN]` Classify any platform presentation service as a hosted RP Instance or registered intermediary and validate RPAC/RPRC key operation with the relevant Registrar/CA.

## Required onboarding record

The record should identify accountable contacts, configured technical actors, source authorities, delegated responsibilities, policy owners, approvers, credential profiles, keys, trust/status sources, retention, incident contacts and environment. It must distinguish “platform executes” from “platform is legally responsible.”

## Multi-tenant isolation

Tenant isolation covers issuer identity and metadata, keys, trust/status configuration, Credential Types, Connectors and secrets, policies, transactions, evidence/audit and administrators. Cross-tenant configuration reuse must copy/version templates rather than share mutable security state.

`[OPEN]` Precise tenancy architecture, hierarchy, delegated administration and isolation controls require threat modelling. Legal identity and residual responsibility are now bounded in the [operating-model analysis](attestation-provider-operating-models.md); jurisdiction-, scheme- and provider-specific validation remains required.

See [general onboarding](onboarding.md), [product model](issuer-product-model.md), [issuer trust and registration](../06-shared-capabilities/issuer-trust-and-registration.md), [RP registration and access](../06-shared-capabilities/rp-registration-and-access.md), and [security](../06-shared-capabilities/security.md).
