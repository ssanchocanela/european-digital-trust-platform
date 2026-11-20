# The EUDI ecosystem sandbox — roadmap after v1

- **Status:** PROPOSED 15 November 2026; **the order of the tracks approved by the user the same day**
  (decision 1 below). Nothing below is built. Each track
  becomes a milestone, with its own PR and STOP, and an ADR where the decision is not obvious, as
  S0–S6 were.
- **Why now:** v1 is deployed and in use by invited participants: the Relying Party and PID Provider
  roles (ADR 0017), sign-in by Access (ADR 0018), and the operator's section (ADR 0019). The user's
  goal is a sandbox **the ecosystem will use** as its place to try the EUDI Wallet ecosystem. That
  needs more roles, more flows, tools to test wallets as well as Relying Parties and issuers, and the
  operations and legal footing of a service that others depend on.
- **What this is not:** a promise of conformance. Every track stays `TEST` only, makes no conformance
  or production-readiness claim (CLAUDE.md §2), and calls the sandbox's wallet build a **modified**
  wallet (§6.22).

## Where v1 stands

| Area | In v1 |
|---|---|
| Roles | Relying Party (`Service_Provider`), PID Provider (`PID_Provider`) |
| Certificates | WRPAC and WRPRC, correct or with a chosen defect (specification §5) |
| Hosted services | A verifier per RP service; a PID issuer per PID Provider service; run reports |
| Lists | WRPAC, WRPRC and PID lists (ETSI TS 119 602), the register, the TS5 read API |
| Formats | SD-JWT VC PIDs (`dc+sd-jwt`, `urn:eudi:pid:1`) |
| People | Sign-in by Access e-mail; organisations, members, invitations, API keys; optional PID |
| Operator | `/admin`: views, suspension, invitations, sessions |
| Wallets | One: the EDTP sandbox build, modified |

## The tracks, in the proposed order

The order puts first what unblocks other participants, then what deepens the testing, then what
opening up requires. Within a track, the first bullet is the smallest useful step.

### R1 — Wallet Providers bring their wallets ([ADR 0020](../adr/0020-sandbox-wallet-provider-role.md), accepted) — *built 15 November 2026, not deployed*

- A `wallet_provider` service; the provider uploads the public CA certificate of its wallet
  attestations; the operator approves it; the sandbox publishes a `WalletProviders` list; the hosted
  PID issuers use it.
- A public page, "Use your wallet with the sandbox": the four list URLs and the signer's pin.
- Run reports name the wallet that was used.
- **Before building:** read in the engine's source which wallet-attestation formats it checks
  (ADR 0020 Open 1).

### R2 — More attestations than the PID ([ADR 0023](../adr/0023-sandbox-eaa-providers.md), accepted) — *non-qualified EAAs built and deployed 20 November 2026; no wallet run yet*

- **EAA Providers**, non-qualified first: a participant defines a credential type and a `vct`, gets
  an attestation-signing certificate from a sandbox CA, and issues from a hosted issuer. The engine
  already issues EAAs (Milestone 2); the sandbox wraps it.
- **Relying Parties request EAAs** as well as PIDs: intended uses with any registered type.
- **QEAA and PuB-EAA** later. They need their own trust-domain stand-ins and defect catalogues, and the
  investigation of what a wallet build checks for each (as CLAUDE.md §1 did for EAAs, finding B7).
- **mdoc** (`mso_mdoc`) for the PID and then for EAAs: v1.1 item G-9.

### R3 — Testing wallets, not only services ([ADR 0022](../adr/0022-sandbox-testing-wallets.md), accepted) — *plans, observations and signed reports built 15 November 2026; the CI API not yet*

- **A wallet tester.** The sandbox acts as a Relying Party or an issuer and deliberately misbehaves:
  - a defective access or registration certificate, as v1 already does;
  - malformed requests;
  - a wrong `client_id`;
  - expired or revoked status;
  - an unsigned metadata variant.

  It records what the wallet did. This is the defect catalogue, turned round to face the wallet. Its
  value is highest for R1's Wallet Providers.
- **Run reports to keep:** exportable (JSON and a printable page), comparable across wallet builds.
- **An API for continuous integration:** the organisation API keys already exist. They need routes
  to start runs and fetch reports without the portal.

### R4 — More of the protocols

- OpenID4VCI **authorization-code flow** beside pre-authorised; **batch issuance**. Batch issuance
  depends on the upstream EUDIPLO change in `docs/upstream/eudiplo-batch-attestation-proof.md`, which
  is not yet filed.
- **Status and revocation everywhere:** status lists for every issued attestation, suspension and
  reinstatement as the rules allow (CLAUDE.md §6.7).
- **The browser Digital Credentials API** for presentation, beside `SAME_DEVICE` and `QR`.
- **Cross-device**, still the discouraged flow it is (CLAUDE.md §6.9), with its mitigations stated in
  every report.

### R5 — The registrar, as a participant would meet it

- The TS5 read API is there. Next:
  - **change notifications** to subscribers;
  - **registration-certificate renewal and revocation flows** a participant drives;
  - **intermediaries** (Article 5b(10)). Intermediaries are an operating profile of their own, gated
    on the legal question Q2 for the platform.

### R6 — Opening up

- **Self-service sign-up beyond invitations** (ADR 0017 Open 2): widen the Access policy, with the
  quotas and suspension already in place, and rate limits watched.
- **Documentation for participants:** getting started, one guide per role, the defect catalogue
  explained, and examples in the main languages.
- **A public status page** and announcements: list rollovers, resets, deployments.
- **Publishing the sandbox wallet build** on `/wallet`, once the EUPL reading is confirmed
  (ADR 0017 Open 1).

### R7 — Operating a service others depend on

- **Erasure of a person on request** (ADR 0019 Open 1), before any outside participant is admitted —
  *[ADR 0021](../adr/0021-sandbox-erasure-of-a-person.md), built 15 November 2026, not deployed.*
- **The nightly dump switched on** (decided off until the user says), restore tested.
- **Monitoring and alerts** beyond the negative checks: errors, quota pressure, list freshness, CA
  certificate expiry.
- **Key rotation** for the sandbox's CAs and list signer, rehearsed.
- **Capacity:** the `cx23` VM is enough for invited participants. Measure before outside participants
  arrive.

### R8 — Legal and governance

- **Terms of use, a privacy notice** for participants' addresses and data, and the platform's role
  towards them.
- **The EUPL confirmation** for the wallet build (ADR 0010 Open 3).
- **The processor-or-intermediary question (Q2)** stays the gate for anything `PRODUCTION`. The sandbox
  never leaves `TEST`.

## What needs the user's decision first

1. **The order of the tracks** — **decided 15 November 2026: as proposed.** R1 → R7 (erasure only) →
   R3 → R2 → R6 → R4 → R5, with R8 running alongside from the start, because opening up waits on it.
2. **Who the first outside participants are.** That decides whether R6 is needed soon or late.
3. **Whether the sandbox should check wallets' behaviour (R3) at all,** or leave that to official
   conformance tooling. A tester is valuable, and it is also the place where it is easiest to imply
   conformance by accident.

## Principles that carry over to every track

- **No simulated success** (CLAUDE.md §8). A flow that needs a real wallet is run with one, or stated
  as not run.
- **Every defect and every check cites its source,** pinned, and never claims conformance.
- **Participant-supplied trust is approved by the operator** and never reaches sign-in (ADR 0015
  Decision 2, ADR 0020 §5).
- **Every deployment is confirmed by the user first** (CLAUDE.md §6.20).
