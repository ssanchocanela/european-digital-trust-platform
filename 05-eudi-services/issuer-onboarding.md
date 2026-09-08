# Issuer Onboarding

**Status:** [PRODUCT] / [OPEN]

Issuer onboarding creates a usable, isolated issuing context; it is distinct from relying-party onboarding and from a technical protocol session.

## Proposed onboarding flow

1. Establish the Tenant, Organisation, administrators and separation-of-duties roles.
2. Record the intended issuer identity, legal-role hypothesis, jurisdictions and Attestation Scheme.
3. Configure one or more Authentic Sources and their Connectors, including data purpose and permitted attributes.
4. Define the Credential Type and supported Credential Configurations/formats.
5. Define mappings, Eligibility, Approval, Validity and Lifecycle Policies.
6. Select and approve a Delegation Profile for every lifecycle step.
7. Configure signing/key custody, status, trust, issuer metadata and any registration/certificates.
8. Validate connectivity without retaining unnecessary source data.
9. Run negative, lifecycle, conformance and official EUDI Reference Wallet interoperability tests.
10. Approve environment promotion with an immutable configuration/version record.

## Required onboarding record

The record should identify accountable contacts, configured technical actors, source authorities, delegated responsibilities, policy owners, approvers, credential profiles, keys, trust/status sources, retention, incident contacts and environment. It must distinguish “platform executes” from “platform is legally responsible.”

## Multi-tenant isolation

Tenant isolation covers issuer identity and metadata, keys, trust/status configuration, Credential Types, Connectors and secrets, policies, transactions, evidence/audit and administrators. Cross-tenant configuration reuse must copy/version templates rather than share mutable security state.

`[OPEN]` Precise tenancy architecture, hierarchy, delegated administration and isolation controls require threat modelling. `[OPEN] Requires legal/regulatory analysis.` Attestation Provider identity and allocation of liability under Gateway, Full Issuer and Hybrid models are not concluded here.

See [general onboarding](onboarding.md), [product model](issuer-product-model.md), and [security](../06-shared-capabilities/security.md).
