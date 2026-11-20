# ADR 0023 — EAA Providers in the sandbox: non-qualified attestations beyond the PID

- **Status:** ACCEPTED, 20 November 2026, by the user. Built in the same PR as this ADR, so that the
  ADR cannot reach `main` without its code. The open items were read in source before building; the
  answers are below, and one of them changed §6.
- **Date:** 18 November 2026
- **Roadmap:** track R2, next in the order the user approved (R1 → R7 → R3 → **R2** → R6 → R4 → R5).
- **Builds on:**
  - [`docs/milestone-2-issuer-trust.md`](../milestone-2-issuer-trust.md) and finding B7: the pinned
    wallet build has no trust list and no classification for a non-qualified EAA, so issuer trust
    for one throws;
  - [`docs/issuer-trust-model.md`](../issuer-trust-model.md): gate (a), provider authentication, and
    gate (b), attestation signature trust (ARF §6.3.2.4);
  - the hosted PID issuer (S5) and its signed metadata (S5b, [ADR 0016](0016-sandbox-signed-issuer-metadata.md));
  - [ADR 0020](0020-sandbox-wallet-provider-role.md), for the pattern of a new role and a new list;
  - [ADR 0022](0022-sandbox-testing-wallets.md), for wallet test plans.
- **Numbered 0023**, the next free number after 0022.

## Context

v1 issues one kind of attestation: the SD-JWT VC PID (`urn:eudi:pid:1`). Most of what the ecosystem
will want to try is not a PID: diplomas, memberships, tickets, licences. Those are electronic
attestations of attributes, and the first kind to support is the **non-qualified** EAA, because it
needs no qualified trust service stand-in.

The engine already issues EAAs (Milestone 2). What has been missing is a **wallet that will accept
one**. B7 found why: for a non-qualified EAA, wallet-core resolves no `VerificationContext` unless
the build declares two things, and the upstream build declares neither
(`tools/test-wallet/deviations.md`, WD-1):

1. `SupportedLists.eaaProviders`, a **map keyed by use case** to a list location;
2. `AttestationClassifications.eaAs`, a map from the same use case to an
   `AttestationIdentifierPredicate` that says which attestations belong to it.

Read on 18 November 2026 in the ETSI consultation library the pinned wallet-core uses
(`eu.europa.ec.eudi.etsi1196x2.consultation`, `IsChainTrustedForAttestation.kt`, v0.4.0-alpha.1),
the predicate is richer than WD-1 assumed. Besides `any(set)` and `equalsTo`, it offers
`sdJwtVcMatching(regex)`, `mdocMatching(regex)` and `or`. **So one wallet build can classify every
credential type a participant will ever define, if the sandbox puts their `vct`s under one prefix.**
Without that, every new type would need a new wallet build, which would make the role unusable.

## Decision

### 1. A new role: the non-qualified EAA Provider

- An organisation adds an **`eaa_provider` service**, as it adds a Relying Party or PID Provider
  service today. Its registration certificate names the attestations it provides.
- **Non-qualified only** in this ADR. QEAA and PuB-EAA are later (§8).

### 2. Credential types, defined by the participant, under one sandbox prefix

- An EAA Provider service defines **credential types**. Each has:
  - a name and a display name, in one or more languages;
  - a list of claims, each with a name, a display name and a type (string, number, boolean, date);
    flat claims only in v1;
  - its registration certificate's `entitlement` is `https://uri.etsi.org/19475/Entitlement/Non_Q_EAA_Provider`,
    the spelling the pinned wallet compares against (`IssuerEntitlements.NON_Q_EAA`, interop finding
    C14), and it lists the provided attestations;
  - which claims are selectively disclosable;
  - a validity period for issued credentials.
- **The `vct` is assigned by the sandbox, never typed:**
  `https://sandbox-platform.murcata.es/sandbox/public/vct/{organisation}/{type}`. The sandbox serves
  the type's **SD-JWT VC Type Metadata** at that address, so a wallet that resolves it can display the
  credential.
- **A published type version is immutable** (CLAUDE.md §3.6). A change is a new version; credentials
  already issued keep theirs.
- **Format:** SD-JWT VC (`dc+sd-jwt`) only. mdoc is later (§8).
- Types appear in the register, with their organisation and service.

### 3. The trust domain: an EAA CA and a fifth list

- Two new members of the sandbox trust domain (`packages/sandbox-pki/src/trust-domain.ts`):
  - `eaa-ca`, **"EDTP Sandbox EAA CA - TEST ONLY"**, listed on the new list;
  - `eaa-ca-untrusted`, listed nowhere, for defects.
- **A fifth list, `EAAProviders.jwt`**, signed by the sandbox LoTE signer like the other four. It carries
  the sandbox EAA CA. It is published with them, and its URL joins the trust sources on the
  "Use your wallet with the sandbox" page.
- **Each EAA Provider service gets an attestation-signing certificate** under `eaa-ca`, as a PID
  Provider service gets one under `pid-ca`. The sandbox issues it; nothing is uploaded, so there is no
  participant-supplied trust to approve (ADR 0020 §5 does not apply).
- The list is the ARF §6.3.2.4 optional mechanism: anchors for a non-qualified EAA come from its
  Rulebook and optionally from a list published per ETSI TS 119 602. Here the "Rulebook" is the
  sandbox's own, and says so. It is **not** a notified list and never claims to be.

### 4. A hosted EAA issuer per service

- Each EAA Provider service gets a **hosted issuer**, as a PID Provider service does: one engine tenant
  per service (CLAUDE.md §6.4), with **signed issuer metadata** signed with the service's access
  certificate (S5b, CLAUDE.md §6.21).
- **The participant supplies the claim values for each issuance**, in the portal or through the API.
  The portal says they must be **synthetic**. The values are processed ephemerally and never persisted
  or logged by the platform (CLAUDE.md §5); the engine holds them for its configured window, then
  anonymises them.
- **Defect variants**, as for the PID:

  | Id | Defect | How it is produced |
  |---|---|---|
  | EAA-00 | *Correct* | Signed under the sandbox EAA CA |
  | EAA-01 | Signing certificate not on the EAA list | Signed under the **untrusted** EAA CA |
  | EAA-02 | Signing certificate expired | Leaf `notAfter` in the past at issuance |

  Their citation, verified in the register at the pinned ARF commit, is **`AS-AP-10-010` (`ISSU_10`)**:
  a Wallet Unit "SHALL validate the signature of the EAA **if it has access to the trust anchors** of
  the EAA Provider", and its note adds that Wallet Units are not required to hold the anchors of every
  EAA Provider. So EAA-01 asks something **conditional** of a wallet: a wallet without the sandbox list
  is not required to refuse. The report states the requirement in those words. On the Relying Party
  side the citation is `EW-PIO-01-027` (`OIA_15`): anchors per the applicable Rulebook.

### 5. Relying Parties request EAAs

- An intended use may name **any credential type in the register**, not only the PID. The claim paths
  are checked against that type's claims, with the same path-subset rule (CLAUDE.md §6.2).
- The hosted verifier trusts the EAA list for those types, as it trusts the PID list for the PID.

### 6. The sandbox wallet build: WD-1, with a prefix

**Amended on acceptance (Open 1, read in source).** WD-1 cannot be configuration. wallet-core v0.30.2
combines the list locations the app gives it with a fixed set of list profiles, `SupportedLists.eu()`,
and at the pinned ETSI library that set has **no** profile for any EAA use case. A configured
`eaaProviders` location is dropped without a message (interop finding C16). The same is true of
`pubEaaProviders`, so WD-9 has never had an effect.

The ETSI library's building blocks are public, and wallet-core accepts an app-built trust source for
issuer trust (`IssuerTrustConfigBuilder.trustSource(IsChainTrustedForEUDIW)`). So WD-1 is **app code
in our per-flavour copy**, no upstream file edited:

- a trust source built with `ProvisionTrustAnchorsFromLoTEs.eudiwJvm`, whose profiles are upstream's
  `SupportedLists.eu()` **plus** one EAA use case, `edtp-sandbox`, selecting the list's services by
  the sandbox's service type identifiers, with `VerificationContext.EAA("edtp-sandbox")` for issuance
  and `EAAStatus("edtp-sandbox")` for revocation;
- the same list locations as the rest of the build (PID, WRPAC, WRPRC), plus the EAA list;
- the same relaxations upstream's demo configuration applies (`relaxCertificateProfiles`,
  `relaxPkixRevocation`);
- classifications: upstream's PID predicate, plus
  `eaAs = mapOf("edtp-sandbox" to sdJwtVcMatching(Regex("^https://sandbox-platform\\.murcata\\.es/sandbox/public/vct/.+")))`.

The wallet selects a list's services by **service type identifier**; it does not check the list's
`LoTEType` (`ProvisionTrustAnchorsFromLoTEs.createValidators`). No ETSI value exists for a
non-qualified EAA providers list, so the sandbox uses identifiers in its own namespace and says so.

- **One build serves every type** participants define. The prefix is the sandbox's own address, so it
  cannot match a real attestation.
- It remains a **modified wallet** (CLAUDE.md §6.22); WD-1 is recorded as built for the sandbox profile
  only, and `BuildConfig.EDTP_DEVIATIONS` names it.
- **Other wallets** (ADR 0020): the guide page gives the list URL, its service type identifiers and the
  prefix, so a Wallet Provider can configure the same thing.

### 7. Wallet testing

ADR 0022 gains a fourth plan, **"EAA issuance"**: EAA-00, EAA-01, EAA-02 on the participant's hosted
EAA issuer, with a sandbox-defined test type. Same observations, same words, same signed report.

### 8. Not in this ADR

- **QEAA and PuB-EAA.** Each needs its own trust-domain stand-in, its own defect catalogue and, first,
  the investigation of what the pinned wallet build checks for it, as B7 was for EAAs.
- **mdoc** (`mso_mdoc`), for the PID and for EAAs (v1.1 item G-9).
- **Nested claims and arrays** in credential types.
- **Revocation of issued EAAs.** Status lists everywhere are R4.

## Considered and rejected

- **One wallet classification per credential type** (`any(setOf(SDJwtVc(vct)))`, as WD-1 was first
  written). Every new type would need a new wallet build. Unworkable for a sandbox whose participants
  define types.
- **Let participants choose their own `vct`.** A free `vct` cannot be matched by one predicate, and it
  could imitate a real type. The sandbox assigns it.
- **Classify sandbox EAAs as PIDs or PuB-EAAs** to reuse an existing list. It would test the wrong
  path, which is exactly the "terminology similarity" error CLAUDE.md §2 warns against.
- **Relax the wallet's issuer-trust check** (`forVct(..., INFORM)`). It skips the mechanism instead of
  exercising it; WD-1 configures the mechanism the ARF intends.

## Consequences

- **Positive.**
  - Participants can try the attestations they actually care about, end to end, with a real wallet.
  - Relying Parties can request them.
  - Wallet Providers get a third trust path to test, beside access certificates and the PID.
- **Negative.**
  - **A new wallet build** is needed, and handed out again. Until it is, EAAs issue but the sandbox
    wallet refuses them, which is B7 and must be stated, not hidden.
  - **More to manage:** a CA, a list, a key per service, type metadata to serve.
  - **Participants type claim values.** The "synthetic only" rule is a statement, not a control. The
    platform never keeps the values, which limits the harm.
- **Changed on acceptance:**
  - the specification (the role, credential types, EAA-00 … EAA-02);
  - the roadmap (R2);
  - `tools/test-wallet/deviations.md` (WD-1, prefix form);
  - `security-limitations.md`;
  - the gateway allow-list (`/sandbox/public/vct/…`, `EAAProviders.jwt`).

## Open — answered in source on acceptance, 20 November 2026

1. **The `LoTEType` the wallet requires.** None: services are selected by service type identifier.
   But wallet-core consults no EAA list at all without app code. §6 was amended accordingly.
2. **Whether the pinned wallet fetches SD-JWT VC Type Metadata.** No: its SD-JWT VC verifier runs with
   `TypeMetadataPolicy.NotUsed`, and display comes from the issuer metadata. The sandbox still serves
   Type Metadata at the `vct`, for other wallets; the pinned build does not use it.
3. **The HLR identifiers.** `AS-AP-10-010` (`ISSU_10`) for the wallet, `EW-PIO-01-027` (`OIA_15`) for
   the Relying Party, `AS-AP-10-062` (`ISSU_34a`) for the entitlement check (§4).
4. **Participant-defined claim sets in the engine.** Each type version becomes a platform
   `CredentialType` and issuance policy, provisioned to the engine as its own credential
   configuration, as the PID already is. No engine change.
5. **Quotas:** ten types per service, and twenty versions per type.

## Status of claims

None. The sandbox issues non-qualified EAAs under a `TEST` trust domain of its own, with a list that is
not a notified list. It makes no claim of conformance with ARF 3.0.0, any Technical Specification or
ETSI TS 119 602, and calls its own build a **modified** wallet.
