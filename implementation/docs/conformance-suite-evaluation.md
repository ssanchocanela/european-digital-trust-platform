# OpenID Foundation conformance suites: feasibility

**Nothing has been run.** This is the evaluation asked for, from the suite's own repository. No
account was created and no hosted service was used.

## Verdict

**Feasible, self-hosted, and worth doing — it is the only interoperability evidence available to us
that does not need a wallet.** Both relevant suites exist, both have HAIP variants, and the suite can
run locally with no OpenID Foundation account. The cost is a Java/Maven build plus MongoDB and some
networking work, not an approval process.

The reason this matters more than it first appears: in a **verifier** test the suite *plays the
wallet*, and in an **issuer** test it plays the wallet too. So it sidesteps blockers B1 and B7
entirely — neither a trusted access certificate nor a modified wallet build is needed to get a
protocol-level result.

## What exists, at `gitlab.com/openid/conformance-suite` (`master`, checked 11 September 2026)

The suite's own README advertises OIDC, FAPI and eKYC and does **not** mention OID4VCI or OID4VP,
which is misleading — the modules are there:

| Package | Test plans | Modules | Relevance |
|---|---|---|---|
| `vci10issuer` | `VCIIssuerTestPlan`, **`VCIIssuerTestPlanHaip`** | 24 | **Our issuance side.** The HAIP variant is the one EUDI profiles against |
| `vp1finalverifier` | `VP1FinalVerifierTestPlan`, **`VP1FinalVerifierTestPlanHaip`** | 18 | **Our verification side**, OpenID4VP 1.0 final |
| `vci10wallet`, `vp1finalwallet` | — | — | Wallet-side. Not us |
| `vpid2*`, `vpid3*` | — | — | Earlier OpenID4VP drafts. Only if a counterparty pins one |

Module names that map directly onto decisions we have already made and would otherwise only be able
to assert:

| Module | What it would check for us |
|---|---|
| `VP1FinalVerifierClientIdPrefix` | That our `x509_hash` client-id prefix is formed correctly — the scheme the pinned wallet enables, so this is the highest-value single test |
| `VP1FinalVerifierHappyFlow` | The whole request/response exchange, including `direct_post.jwt` |
| `VP1FinalVerifierCredentialFormat` | Our `dc+sd-jwt` handling |
| `AbstractVP1FinalVerifierNegativeTest` (and its subclasses) | That we **reject** what we should. Our own suite tests the failure taxonomy against the engine; this tests it against an adversarial peer |
| `VCIIssuerBatchIssuance` | Batch issuance, which we set to `batchSize: 1` — so this would confirm the metadata we advertise matches what we do |
| `VCIIssuerFailOnClientAttestationExpInPast` | Wallet-attestation validation, which we currently leave at the engine's default |

## Running it without an account

`docker-compose-dev.yml` starts MongoDB, nginx and the suite, with:

```
--fintechlabs.devmode=true
--fintechlabs.startredir=true
--fintechlabs.base_url=https://localhost.emobix.co.uk:8443
```

`devmode=true` is what makes this viable: it bypasses the OIDC login that the hosted instance at
`certification.openid.net` requires. `application.properties` otherwise expects a Google OIDC client
for admin rights, which is exactly the external-account dependency we are avoiding.

`localhost.emobix.co.uk` is public DNS that resolves to `127.0.0.1`, so the suite gets a real TLS
certificate while talking to itself. Worth knowing before someone treats the hostname as an external
call.

### What it costs

| | |
|---|---|
| Build | Maven + JDK to produce `fapi-test-suite.jar`, or use `docker-compose-prebuilt.yml` to skip the build |
| Runtime | MongoDB 6.0.13, nginx, the suite. Three more containers alongside ours |
| Ports | 8443/8444/8445 |
| Networking | **The real work.** The suite must reach our endpoints and vice versa. Simplest is to attach it to the `edtp-v0` compose network so it can use `http://platform-api:3100` and `http://eudiplo:3000` by service name |
| Our side | A test tenant, a published policy, and a credential configuration — all of which `smoke-vaas.sh` already creates |

### The one thing to check before committing effort

Whether the VP verifier plan can drive a verifier that uses **`x509_hash`** with a self-signed
certificate, or whether it insists on a chain it can validate. If the latter, the verifier plan needs
the same certificate that blocker B1 is about and the independence advantage is lost for that half.
`VP1FinalVerifierClientIdPrefix` is where to look. The issuer plan should not have this problem,
because there the suite validates *our* metadata rather than a certificate chain.

## What a pass would and would not mean

**Would:** that our OpenID4VP request objects and OpenID4VCI metadata and credential responses are
well-formed and behave correctly against an independent, adversarial implementation of the
specification. That is genuinely more than our own contract tests prove, because those assert against
the engine we wrap — a shared-mistake risk.

**Would not:** ARF or TS conformance. The suite tests OpenID4VP/OID4VCI and HAIP, not the ARF's
high-level requirements. It cannot tell us anything about `RPRC_19`, the trust gates in
[`issuer-trust-model.md`](issuer-trust-model.md), or whether a Wallet Unit would accept our
certificates. A green suite result alongside B1 and B7 still standing is the expected outcome, and
saying so plainly is the point.

Formal **certification** — a listed result on openid.net — is a different thing again: it needs the
hosted instance, an account, and a submission. Out of scope for V0 and not proposed.

## Recommendation

Run `VP1FinalVerifierTestPlanHaip` first, self-hosted. It is the cheaper of the two to stand up
(verification is already end-to-end), it targets the client-id prefix question we most want an
independent opinion on, and it produces wallet-independent evidence for the part of the platform that
is furthest along. Then `VCIIssuerTestPlanHaip` once issuance has been exercised through the API.

**Before either**: the suite and MongoDB are third-party containers and the plans may reach external
URLs during a run. That is a deliberate outward-facing step, so it needs a decision rather than being
folded into a test script — which is why nothing here has been executed.
