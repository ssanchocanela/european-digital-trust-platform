# ADR 0022 — Testing wallets in the sandbox

- **Status:** ACCEPTED, 15 November 2026, by the user. §1–§4 built the same day, in a follow-up PR:
  PR #58 was merged carrying only this ADR. **§5, the API for continuous integration, is not built
  yet.** That API works on an organisation's API key, which names a tenant and not a person, and the
  plan service is written for a signed-in person. It is a follow-up of its own. **Not deployed yet.**
  Roadmap track R3, next in the order the user approved. It answers the roadmap's decision 3: whether
  the sandbox should check wallets' behaviour at all.
- **Date:** 15 November 2026
- **Builds on:**
  - [`specification.md`](../sandbox/specification.md) §5, the defect catalogue, and §6, the run report;
  - the hosted verifier (S4) and the hosted PID issuer (S5), whose runs already exercise a wallet;
  - [ADR 0020](0020-sandbox-wallet-provider-role.md): Wallet Providers bring their wallets.
- **Numbered 0022**, the next free number after 0021.

## Context

The sandbox already puts wallets in front of deliberate defects:
- every hosted-verifier run presents an access certificate and a registration certificate of a chosen
  variant (AC-00 … AC-06, RC-00 … RC-13);
- every hosted-issuer run signs with a chosen PID variant.

Each run has a report with the defect, its citation, the engine's outcome, and the tester's
observation (§6). What is missing is a view **from the wallet's side**:
- one wallet build taken through a set of defects in order;
- what the sandbox itself observed, kept apart from what the tester reported;
- one report for that build that can be kept, exported and compared with the next build.

With ADR 0020, Wallet Providers are participants. For them this is the sandbox's main value.

The roadmap left one question open. Should the sandbox judge wallets at all? A tester is useful. It is
also where a report most easily slides from "this is what happened" into "this wallet is conformant".
CLAUDE.md §2 rule 3 forbids that, and §5.4 already says a report never says "the wallet complied".

## Decision

### 1. Yes, as observation, never as a verdict

The sandbox **exercises** wallets and **reports what happened**. It does not grade them:
- **No pass, fail, score or conformance statement** appears in any report, page or export, for any
  wallet, ours included.
- **The words are fixed.** A step's outcome is one of the observations in §3. Every report and page
  carries the sentence "This is not a conformance test and certifies nothing." A test fails the build
  if a wallet-test page or export contains "pass", "fail", "conformant", "compliant" or "certified".
- **Each step states what the cited requirement asks of a wallet, in the requirement's words,** next
  to what was observed. Whoever reads the report draws the conclusion.

### 2. Wallet test plans: existing runs, in an order, for one build

- **A plan is a named, versioned list of steps.** Each step is an existing run type with a fixed
  defect variant:
  - "access certificate defects": AC-00, AC-01 … AC-06 on the hosted verifier;
  - "registration certificate defects": RC-00, RC-01 … RC-10 and RC-13, the Relying Party variants
    of the S4 run sheet, with *Check Registration Certificates* on and then off;
  - "issuance": PID-00, PID-01, PID-02 on the hosted issuer.
- **A plan run belongs to one wallet build.** The tester declares:
  - the provider, from the Wallet Provider services in the sandbox (ADR 0020) or "other";
  - the build string;
  - the platform;
  - the *Check Registration Certificates* position.

  The declaration is shown as declared. The sandbox does not verify it.
- **The sandbox sets up each step** on the participant's own hosted verifier or issuer, so no
  configuration by hand is needed between steps. The tester presents with the wallet, and records what
  it showed.
- **The plans are the sandbox's.** Participants cannot write them in v1. That keeps every step tied to
  the defect catalogue and its citations.

### 3. What is observed, by whom

Each step keeps two observations apart, and never merges them:

- **The server's observation, automatic.** It comes from the platform's transaction state, never the
  engine's status (CLAUDE.md §6.5). As built, presentations and issuances are read separately:
  - for an issuance, `credential_collected` replaces `presented`. Whether the wallet then kept the
    credential happens in the wallet, and only the tester can say. `issuer_refused_wallet` means the
    issuer did not trust the wallet's attestation;
  - `engine_refused` became part of `presented`. If the engine refused what the wallet sent, the
    wallet still released it.

  The cases:
  - `presented`: a presentation arrived, and the wallet released data despite the defect. This is the
    one outcome the server observes without doubt;
  - `wallet_error`: the wallet sent an error, such as an explicit `access_denied` (§6.6: best-effort);
  - `no_presentation`: nothing arrived before the step expired. This is **not** "refused": the wallet
    may have refused, failed, or never been used;
  - `engine_refused`: the engine rejected what the wallet sent, with its failure code.
- **The tester's observation, manual,** from the existing list (§6): refused before consent; warned and
  stopped; warned and continued; presented without warning; error; nothing; other.
- **The report shows both, side by side.** Where they disagree (the tester says "refused", the server
  saw `presented`), the report says so.

### 4. Reports to keep

- **One report per plan run:** every step, its defect and citation, the requirement's words, both
  observations, the declared build, and the time.
- **Exported** as JSON and as a printable page.
- **Signed by the sandbox:** the JSON export is a JWS under a sandbox report-signing key, published
  like the other sandbox certificates. A participant can then show a report to someone else, and that
  someone can check it came from the sandbox unchanged. The signature says **who produced the report**,
  not that the wallet is good. The report itself says so.
- **Comparable:** two plan runs of the same plan can be shown side by side, for example build 41
  against build 42.

### 5. An API, for providers who automate

The organisation API keys (ADR 0015 Decision 8) reach new routes:
- start a plan run;
- start its next step and get the wallet URI;
- record the tester's observation;
- fetch the signed report.

A provider driving an emulator can then run plans from continuous integration. A person with a phone
uses the portal.

### 6. Not in this ADR: defects the engine cannot produce

Today's steps can only vary what the engine can be configured with: certificates and signing keys.
Many wallet checks need defects in the **protocol messages themselves**:
- a request object with a bad signature;
- a `client_id` that does not match;
- a reused nonce;
- an expired request;
- issuer metadata signed with the wrong key;
- a credential with a broken signature or a revoked status.

Producing those means the sandbox serving OpenID4VP and OpenID4VCI messages itself, outside the engine.
That is a protocol implementation of its own, with its own risks. It is a later ADR, decided once
plans built from today's steps are in use.

## Considered and rejected

- **Grade wallets: pass, fail, a score.** It is what people expect of a tester. It is also a
  conformance claim in all but name, made by an unofficial tool against a modified test domain.
- **Leave wallets to official conformance tooling and do nothing here.** The sandbox already exercises
  wallets with every run. Not organising that into plans and reports wastes the one thing
  Wallet Providers would come for.
- **Let participants write their own plans.** It would cut steps loose from the catalogue's citations.
  This is later, once the plan format has settled.

## Consequences

- **Positive.**
  - A Wallet Provider can take a build through the catalogue in one sitting and keep a signed record.
  - Relying Parties and PID Providers see how the wallets in the sandbox behave.
- **Negative.**
  - **A signed report can be misread as a certificate.** The wording rules (§1) and the in-report
    statement are the control. A test checks the words.
  - **The declared build is not verified.** The report says "as declared".
  - **A new key to manage:** the report-signing key, in the sealed store, published, rotated with the
    others.
- **Changed on acceptance** (done 15 November 2026):
  - the specification (§5.4 gains plans, §6 gains the plan report);
  - the roadmap (R3);
  - `security-limitations.md`.

## Open

1. **Which plans ship first.** Proposed: the three listed in §2, as they are today's catalogue.
2. **The protocol-level defects** (§6): a separate ADR.
3. **Whether reports may be published** by the participant on the sandbox, for example a public page per
   wallet build. Not in v1: reports are private to the organisation that ran them.

## Status of claims

None. The sandbox exercises wallets against a `TEST` trust domain and records what happened. It
certifies nothing, makes no claim of conformance with ARF 3.0.0 or any Technical Specification for any
wallet, and calls its own build a **modified** wallet.
