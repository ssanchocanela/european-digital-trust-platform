# ADR 0020 — The Wallet Provider role in the sandbox

- **Status:** PROPOSED, 15 November 2026. Drafted at the user's request: "in the medium term we will
  have to accept other wallets, by letting Wallet Providers update the list of accepted wallets by
  uploading the public part of their certificate".
- **Date:** 15 November 2026
- **Builds:**
  - [`specification.md`](../sandbox/specification.md) §2, which lists the Wallet Provider as a later
    role;
  - [`s0-findings.md`](../sandbox/s0-findings.md) §2, which found that a third-party wallet can use the
    sandbox only if it can be configured with the sandbox's lists;
  - the plan's v1.1 item "brought-in anchors with operator approval", extended from PID Providers to
    Wallet Providers.
- **Follows:**
  - [ADR 0014](0014-sandbox-trust-domain.md), the sandbox trust domain and its lists;
  - [ADR 0015](0015-sandbox-sign-in-by-pid.md) Decision 2: sign-in never trusts a participant's
    anchor;
  - [ADR 0019](0019-sandbox-operator-section.md), the operator's section, where approvals happen.
- **Numbered 0020**, the next free number after 0019.

## Context

Today exactly one wallet works with the sandbox: the EDTP sandbox build, a **modified** build of the
Reference Implementation (CLAUDE.md §6.22). Two things make that so, one in each direction.

1. **The sandbox trusts only one family of wallets.** A hosted PID issuer checks the wallet's
   attestation against Wallet Provider anchors. The operator copies those anchors to the VM by hand:
   the seven EU development Wallet Providers, in `wallet-provider-anchors/`. A wallet from anyone else
   is refused at issuance.
2. **Only that build trusts the sandbox.** The sandbox's Access CA, Registrar and PID CA are on no
   notified list, so an official wallet refuses them, by design (`AS-WP-06-005`, `RPA_04`, for access
   certificates). A wallet uses the sandbox only if it can be pointed at the sandbox's own lists.

The sandbox is meant to be used across the ecosystem. Wallet Providers are part of that ecosystem.
They need to bring their wallets, and to see how Relying Parties and PID Providers treat them.

## Decision

### 1. A Wallet Provider is a participant with a service of that role

- An organisation registers a service with the role **`wallet_provider`**, in the portal, as it does
  for a Relying Party or a PID Provider.
- It needs no access or registration certificate from the sandbox for this. What it needs is for its
  anchor to be trusted.
- The register lists it as a Wallet Provider, marked **not verified**, as every organisation is
  (ADR 0015 Decision 6).

### 2. It brings its own anchor: the public certificate only

- **What is uploaded:** the PEM certificate of the CA that signs the provider's wallet attestations.
  The public part only.
- **What the platform refuses,** before anything is stored:
  - any input that contains a private key (`PRIVATE KEY` anywhere in it);
  - more than one certificate;
  - a certificate that is not a CA: `basicConstraints` CA must be true, and `keyUsage` must include
    `keyCertSign`;
  - an expired certificate, or one valid for more than 20 years;
  - a key other than EC P-256/P-384 or RSA ≥ 3072;
  - the sandbox's own CAs, and the anchors already on the list.
- **What is kept:** the certificate, its SHA-256 fingerprint and its subject. Never anything else.
- **The limit:** at most two anchors per Wallet Provider service, one current and one next, for
  rollover.

### 3. The operator approves it before any issuer trusts it

- An uploaded anchor is **pending**. It reaches no list until the operator approves it in `/admin`
  (ADR 0019). The operator can also refuse it, with a reason that the provider sees.
- **Why approval, and not automatic:** an anchor on the list makes every hosted PID issuer issue PIDs
  into the wallets that anchor vouches for. In a `TEST` domain that harm is small, but it is not none.
  The operator also needs to know who the Wallet Providers are.
- **Suspending the organisation removes its anchors from the list** at the next publication. So does
  the provider withdrawing one.
- Every step is audited: uploaded, approved, refused, withdrawn, removed by suspension.

### 4. The sandbox publishes its own Wallet Providers list

- **Where:** a fourth list, `/sandbox/public/lote/WalletProviders.jwt`, an ETSI TS 119 602 list signed by
  the sandbox's list signer, like the other three. It is republished on change and before
  `NextUpdate`.
- **What it carries:**
  - the anchors the operator places by hand, which are the EU development Wallet Providers, so the
    sandbox build keeps working;
  - every approved participant anchor.
- **Who reads it:**
  - every hosted PID issuer. Its engine tenant's Wallet Provider trust list is rewritten from the
    published list whenever the list changes, instead of being loaded once from the files;
  - any wallet or issuer outside the sandbox that wants to see the same list.

### 5. The separations that must hold

- **Sign-in never trusts a Wallet Provider anchor.** The sign-in verifier trusts only its fixed PID
  anchor set (ADR 0015 Decision 2). A Wallet Provider's anchor goes only on the Wallet Providers list,
  never on the PID list.
- **The PID list is unchanged.** A Wallet Provider cannot make a PID trusted, only a wallet.
- **The startup check gains the new list.** The sign-in policy must not name the Wallet Providers
  list either.

### 6. Other wallets trusting the sandbox: published, not configured for them

- The sandbox cannot make a third-party wallet trust it. It can make that easy and unambiguous:
  - **A public page, "Use your wallet with the sandbox",** under `/sandbox/public/`. It gives the four
    list URLs, the list signer's certificate and its SHA-256 pin, and what each list is for (access
    certificates, registration certificates, PIDs, Wallet Providers).
  - **The sandbox build stays the worked example.** Its `--profile sandbox` is the configuration, in
    code, that a provider can read.
- **Results name the wallet.** A run report records the wallet as the participant states it: its
  provider and build. It is never "the Reference Wallet". A result from a participant's wallet is that
  wallet's result.

### 7. What this ADR does not do

- **Certify, test or rank wallets.** A tester that checks a wallet's own behaviour is a separate,
  larger piece of work. See the roadmap, R3.
- **Issue wallet attestations for providers.** The sandbox does not act as a Wallet Provider's CA, and
  providers sign with their own keys.
- **Hold any private key of a provider,** ever.

## Considered and rejected

- **Automatic acceptance of any uploaded anchor.** Simpler, and it makes the operator blind to who can
  receive PIDs from every hosted issuer. Approval costs one click.
- **The sandbox issues Wallet Providers a CA certificate, as it does access certificates.** That would
  test the sandbox's PKI, not the provider's wallet. Real Wallet Providers sign with their own
  infrastructure, and that is what the sandbox should accept.
- **Keep the anchors as files on the VM, and the operator adds them by SSH.** It is what exists today.
  It does not scale beyond a handful of providers, and no participant can see or manage their own
  anchor.

## Consequences

- **Positive.**
  - Wallet Providers can bring their wallets to the hosted PID issuers.
  - Relying Parties and PID Providers can test against more than one wallet.
  - The sandbox's lists become a complete, published set that any wallet can be pointed at.
- **Negative.**
  - **A new kind of participant-controlled trust,** gated only by operator approval. It is a `TEST`
    domain, and the approval is the control.
  - **The engine's Wallet Provider list is rewritten on change.** It needs a job, and a test that a
    removed anchor stops issuance at the next issuance after publication.
  - **A third-party wallet's behaviour is outside the sandbox's control.** A failure may be the
    wallet's, and the run report must say so neutrally.
- **To change on acceptance:**
  - the specification's §2 (the Wallet Provider moves into scope), its journeys, and §8;
  - the plan (a milestone, see the roadmap R1);
  - `security-limitations.md`;
  - the negative checks (the new public page and list).

## Open

1. **Which wallet-attestation formats the pinned engine accepts** for issuance, and whether it checks
   the attestation against the list for every format. To be read in the engine's source before
   building, not assumed.
2. **Whether a run report can name the wallet from the attestation itself,** rather than from what the
   participant states.
3. **Whether Relying Parties should see wallet attestations too.** Some flows present them to
   verifiers. Not in v1 of this role.

## Status of claims

None. This is a `TEST` environment with synthetic data. It makes no claim of production readiness, and
no claim of conformance with ARF 3.0.0 or any Technical Specification. A wallet accepted in the sandbox
is accepted by the sandbox only.
