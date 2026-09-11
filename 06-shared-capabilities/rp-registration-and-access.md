# Wallet-Relying-Party Registration and Access

**Decision date:** 9 September 2026

**Status:** [IMPLEMENTING-ACT] / [SPECIFICATION] / [PRODUCT-HYPOTHESIS] / [OPEN]

## Current terminology and applicability

The binding names are **wallet-relying party access certificate** and **wallet-relying party registration certificate**, commonly shortened here to **RPAC** and **RPRC**. `[IMPLEMENTING-ACT]` Regulation 2025/848 defines RPAC as the certificate used to authenticate/validate the wallet-relying party and RPRC as the data object describing intended use and registered attributes.

`[IMPLEMENTING-ACT]` RPAC issuance is mandatory infrastructure: Member States authorise at least one Access CA and certificates are issued only to registered wallet-relying parties (Article 7). RPRC infrastructure is conditional: a Member State **may** authorise a provider; if it does, Article 8 controls intended-use and attribute scope. Regulation 2025/848 applies from **24 December 2026**, so this is a target-state design on the analysis date.

`[SPECIFICATION]` ARF 3.0 often shortens the names to **access certificate** and **registration certificate** and distinguishes a Relying Party, Relying Party Service and Relying Party Instance. This is terminology simplification, not a different trust mechanism.

## Two independent trust relationships

| Relationship | Question | Artefacts/actors | Does not prove |
|---|---|---|---|
| RP trust | Who requests PID/attributes, for what registered service/use? | `[IMPLEMENTING-ACT]` RP registration, RPAC, optional RPRC, Registrar, Access CA/RPRC provider | PuB-EAA or QEAA provider status; source authority; issuer signing authority |
| Issuer trust | Who is entitled/trusted to issue this attestation? | `[REGULATORY]` QTSP trusted list or PuB notification/list; `[SPECIFICATION]` provider access/registration certificate and trust/LoTE resolution | Permission to request arbitrary Wallet data |

## Public body with a platform-operated endpoint

There are two materially different patterns:

1. **Hosted Relying Party Instance.** `[SPECIFICATION]` The public body is registered as the RP and the platform hosts software/hardware that acts as one of its RP Instances. The access/registration artefacts represent the public body and service. `[OPEN]` The acts do not expressly settle third-party private-key hosting; national registration policy, Access CA CPS, contract/security controls and public-body law must permit it.
2. **Intermediary.** `[REGULATORY]` eIDAS Article 5b(10) says an intermediary acting for relying parties is deemed a relying party and shall not store transaction-content data. `[SPECIFICATION]` ARF 3.11.4 requires the intermediary relationship to be **registered and evidenced** — `AS-RP-52-001` (`RPI_01`), `AS-RP-52-003` (`RPI_03`) and `AS-RP-52-004` (`RPI_04`) — and TS5 v1.5 carries `usesIntermediaries`, `isIntermediary` and `servedWRPServices` for exactly that. `[SPECIFICATION]` It does **not** require the Wallet to identify both parties at approval: `AS-RP-52-008` (`RPI_07`) says a Wallet Unit receiving a presentation request from an intermediary on behalf of an intermediated Relying Party “SHALL NOT display the trade names of the intermediary and the intermediary Service to the User when asking for User approval”, and the note to `AS-WP-06-007` (`RPA_06`) says the same from the Wallet Provider side. The approval screen shows the intermediated Relying Party and its Service only. `[REGULATORY]` The platform still cannot use “on behalf” to disappear from the interaction — Article 5b(10) deems the intermediary a relying party in its own right, and `RPI_08` and `RPI_10` impose forwarding and immediate-deletion duties — but that visibility is legal and registered, not rendered on the approval screen.

`[OPEN]` Classification depends on facts: whose service is delivered; who determines purpose/means; who receives presentation data; who controls the endpoint and key; and whether the platform forwards content as a distinct actor. Obtain registrar/data-protection/legal confirmation rather than selecting the less visible label.

## Answers to the delegation hypothesis

| Question | Finding |
|---|---|
| Can the public body be RP while platform operates endpoint? | **Potentially.** `[SPECIFICATION]` Multiple RP Instances are supported. `[OPEN]` Hosting/delegation acceptance is not stated in the binding acts. |
| Can artefacts identify the body but be technically managed by platform? | **Potentially.** `[PRODUCT-HYPOTHESIS]` Automate applications and lifecycle under public-body authorisation. Identity and registered service/use must remain accurate. |
| Can private keys be hosted by platform? | **OPEN.** `[IMPLEMENTING-ACT]` Certificate policy/practice and key protection apply; no general outsourcing permission was found. Require per-tenant non-exportable keys, authorised use and CA acceptance. |
| Can intended use/attributes describe public-body purpose while platform executes? | **Yes in design, conditionally.** `[IMPLEMENTING-ACT]` Registration describes the actual RP, service, intended use and attributes. Execution must not change those facts. |
| What does Wallet display? | `[SPECIFICATION]` The registered trade names of the Relying Party and its Service, from the access certificate — `AS-WP-06-007` (`RPA_06`). If the requester is an intermediary, **only the intermediated Relying Party and its Service**: `AS-RP-52-008` (`RPI_07`) forbids displaying the intermediary's trade names at approval. So in intermediary mode the public body *is* what the User sees, by design. `[INFERENCE]` The platform's accountability is therefore carried by registration and by the Article 5b(10) relying-party qualification, not by the approval screen. |
| Separate identities per tenant? | **Yes.** `[INFERENCE]` Each legal RP/service needs its registered identifier, scoped certificate material and key authorization. Shared platform RP identity would represent the wrong requester. |
| Can platform automate registrar/CA work? | **Technically yes.** `[PRODUCT-HYPOTHESIS]` Application preparation, proof collection, renewal, rotation, revocation monitoring, configuration and evidence can be automated; Registrar/CA decisions and RP accountability remain external. |

## Product controls

- `[PRODUCT-HYPOTHESIS]` Model `RelyingParty`, `RelyingPartyService`, `RelyingPartyInstance`, `IntendedUse`, `RPRegistration`, `RPAC`, optional `RPRC`, `KeyBinding`, `IntermediaryRelationship` and lifecycle events separately.
- `[PRODUCT-HYPOTHESIS]` Partition keys and artefacts by legal RP, service, environment and instance; prohibit platform-wide signing keys for customer-branded RP requests.
- `[PRODUCT-HYPOTHESIS]` Before every request, ensure the requested attributes and purpose match registration/RPRC; produce a human-readable Wallet display preview during onboarding.
- `[PRODUCT-HYPOTHESIS]` Monitor registration/certificate suspension, cancellation, expiry and CA/provider status; stop new requests fail-closed when identity or entitlement cannot be validated.
- `[REGULATORY]` User approval in the Wallet does not itself establish a GDPR processing basis. Record the customer's declared basis/purpose and minimise platform retention.
- `[OPEN]` For intermediary mode, validate the statutory no-storage rule against protocol buffering, logs, fraud controls, retries and support tooling.
- `[OPEN]` TS5 v1.5 carries `isIntermediary`, but it is **not** mapped into the access- or registration-certificate attributes in ETSI TS 119 475, so a Wallet cannot tell from the certificates alone that the requester is an intermediary. It is verifiable only through the Registrar's API. Any control that assumes certificate-level visibility of intermediary status needs rethinking.

## Implementation evidence

`[IMPLEMENTATION-EVIDENCE]` The official [RP Registration Service](https://docs.eudi.dev/latest/build/supporting-ecosystem-services/rp-registration-service/) demonstrates registration, PKCS#12 RPAC issuance and revocation integration. Its own documentation calls it non-production. `[IMPLEMENTATION-EVIDENCE]` EUDIPLO implements registrar/access-certificate workflows. Neither proves legal delegation or production suitability.

## Sources

- [eIDAS Article 5b, including intermediaries](https://eur-lex.europa.eu/eli/reg/2014/910)
- [Implementing Regulation 2025/848](https://eur-lex.europa.eu/eli/reg_impl/2025/848/oj/eng)
- [Implementing Regulation 2024/2982](https://eur-lex.europa.eu/eli/reg_impl/2024/2982/oj/eng) and [2026/1731 amendment](https://eur-lex.europa.eu/eli/reg_impl/2026/1731/oj/eng)
- [ARF 3.0 roles, sections 3.11 and 3.17-3.19](https://eudi.dev/3.0.0/main/03-roles-within-the-eudi-wallet-ecosystem/)
- [ARF 3.0 trust model](https://eudi.dev/3.0.0/main/06-trust-model/)
- [Technical Specification 5](https://eudi.dev/3.0.0/technical-specifications/ts5-common-formats-and-api-for-rp-registration-information/) and [Technical Specification 6](https://eudi.dev/3.0.0/technical-specifications/ts6-common-set-of-rp-information-to-be-registered/)
