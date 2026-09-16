# Where the work stands

Written 12 September 2026, updated 16 September. **The one page to read after `CLAUDE.md` when picking the work up.**

Everything here is state that the code and the git history do not make obvious: what is in flight,
what is blocked and why, and what the next action is. Findings live in their own documents and are
linked rather than repeated.

---

## 16 September 2026 — the platform issued an attestation, end to end

**The first credential this platform has ever issued.** Offer → issuer metadata → authorization
server metadata → DPoP-bound access token on the pre-authorized code → nonce → ES256 key-binding
proof → `POST /vci/credential` **200** → OpenID4VCI clause 10 notification → the platform's
transaction at **`ISSUED`** with an `issuedCredentialId`, and the attestation in the register.

**Say exactly what that is, and what it is not.** It was collected by a **conformant OpenID4VCI
client written for the purpose**, not by a wallet — roughly 120 lines of Node that speak the
protocol. It is evidence that the platform, the wrapped engine and the issuance chain complete a
real issuance. It is **not** evidence about any wallet, and it touches neither trust gate: the
client authenticates nothing about the issuer, which is precisely what a Wallet Unit is required to
do (ARF §6.6.2.2) and cannot (B7).

### Three things this found that nothing else had

**1. The attestation-signing certificate had expired, and nothing said so.** `smoke-issuance.sh`
minted it with `-days 2`; the chain was provisioned on the 13th, so it died on the 15th. Everything
upstream stayed green — the offer minted, resolved over public HTTPS, the token endpoint issued a
DPoP-bound token — and the refusal arrived only at the last call of the flow:
`400 credential_request_denied · Certificate expired on 2026-09-15T08:19:35.000Z`.
**`GET …/provider-authentication` reported nothing about it**, because that report covers trust
gate (a) and this is the attestation key, so the console showed an issuer blocked only by B7 while
it had been unable to sign for a day. The script now mints 90 days (`CERT_DAYS` overrides), prints
the expiry, and says where expiry will surface. And rotating one is now a repository tool rather
than an act of improvisation: [`scripts/rotate-attestation-key.sh`](../scripts/rotate-attestation-key.sh),
which **reads the provider's current state first and refuses to run** if it holds an access
certificate it has not been given a replacement for — because `provision` replaces the whole record,
and a rotation that sent only a signing key would silently remove the other one. That trap caught
this project once on the day, and it is the reason the script exists in the shape it does.

**The report's blind spot is fixed too.** Migration 0008 records the `notAfter` of each supplied
leaf at provisioning — a validity window is not key material, not a credential and not content, so
recording it costs nothing the privacy rules protect — and `provider-authentication` now carries a
`certificates` block and `canSignAttestations`, kept **separate from the trust gate** because they
are separate questions: one is whether a Wallet can authenticate the issuer, the other whether the
issuer can sign at all. The console shows a row per certificate, and a red notice above the gate
when one has expired. A provider provisioned before 0008 reads `notAfter: null` and renders **"not
recorded"**, not "fine" — absence is reported as absence, which is the whole point.

**2. `provision` replaces the whole record, so a re-provision silently drops the access
certificate.** Deliberate, and documented in `issuance.repository.ts`: an `accessCertificate` not
supplied is cleared. The consequence is not obvious from the call site — every issuance under a
provider that has **any** gated policy then fails `attestation_provider_has_no_access_certificate`,
including issuances of policies with no gate, because the issuer configuration is composed per
Attestation Provider (A20). Cost one round trip on the day.

**3. Revocation did not work — and the fix was the engine's own documented field.** `POST
/api/session/revoke` returned **500** for suspend, reinstate and revoke alike. The engine's
`StatusUpdateDto` marks `credentialConfigurationId` optional — *"if omitted, all credentials linked
to the session are updated"* — and **the omitted path is the one that crashes**. One session, one
status, two calls: without the field `500`, with it `204`. The adapter now always sends it, which is
what the platform meant anyway, and the whole lifecycle was then verified live through the platform
API: suspend, reinstate, revoke, and un-revocation refused, with no engine error.
`interop-findings.md` **A26**; report drafted at
[`upstream/eudiplo-session-revoke-optional-field.md`](upstream/eudiplo-session-revoke-optional-field.md),
unfiled.

**The open decision it exposed is not closed by that.** The platform persists a new status *before*
calling the engine, on purpose, and while the engine was failing the register read `REVOKED` for an
attestation whose status list had never been touched — with the API returning `engine_unavailable`
for the same call. The ordering's stated rationale, that the stricter record is the safe direction,
**does not hold**: a Relying Party reads the engine's status list, not our register, so the
attestation kept verifying as valid everywhere it mattered. The workaround removes today's instance,
not the question — any engine failure reproduces it. Whether to keep the ordering, roll the local
change back, or record and retry the divergence is recorded in A26 and deliberately left open.

### The issuance console can now define what it issues — and had never shown an offer

`/issuance/new` exists. The verification side has had `/offers/new` since the console was built; the
issuance side had only the operating screens, so an entity could offer and monitor policies somebody
else had created through the API, and *"define a credential to issue"* was not something the console
could do at all. One form creates the credential type, the policy and a published version, because
those are three objects in the model and one intention on a screen.

It offers **only what this deployment has registered** — read from a new route,
`GET …/issuance-capabilities`, rather than hard-coded, because evaluators and connectors are
resolved at startup and a name the form invented would be refused at publication after five
fieldsets had been filled in. Today that is two evaluators and one connector, and the screen says
outright that **the only authentic source is a fixture**, so anything defined here issues test data.
A warning that would become decoration if a real connector were registered: it disappears when one
is.

**And building it found that the console had never displayed a credential offer.**
`POST /v1/issuances` answers with `interaction: {type, uri}`; the console read `created.offer`, a
field that route has never sent. So `created.offer` was always `undefined`, every offer rendered as
*"No offer open"*, and the QR the whole screen is built around had not once appeared. The QR code
was wired correctly the whole time — it simply never received an offer. Verified end to end after
the fix: define → publish → offer → a 53×53-module QR carrying an `openid-credential-offer://` URI.

**That is the seventh time on this project that a response shape was assumed rather than read** —
after A18, A24, the console's error envelope, the audit envelope, the service-instance field and
`registrationCertificatePublished` on the gate panel. It is comfortably the most expensive pattern
here, and the two cheapest defences remain the same: read the route's answer, and write the test
against a real response rather than a hand-built one.

### The wallet wall moved, and the old explanation was wrong

W4 (`wd-2,wd-3`) was sent a **pre-authorized-code** offer. Its own HTTP log shows the offer fetched
(200) and the issuer metadata fetched (200, `Accept: application/jwt; application/json`, unsigned
JSON) — and then **no further request and no logged error**. That is the identical stop point as
§8.1d, which was an `AUTHORIZATION_CODE` offer. **So §8.1d's conclusion — that the gap is the
authorization-code start — is wrong**: both flows stop before they diverge, in offer resolution.

The silence is structural: `WalletCoreDocumentsController.resolveDocumentOffer` maps the cause to
`IssuerNotTrusted(reason)` or `Failure(message)` — UI states, never log lines. Distinguishing them
needs the screen, and the wallet blocks screenshots, so it needs the accessibility tree, which does
work. **Not yet done.** Note when doing it that the screen cannot settle it on its own:
`toUntrustedIssuerReasonOrNull` maps `IssuerNotTrustedException` **and** `MissingSignedMetadata` to
the same `ACCESS_CERTIFICATE` reason, so gate (a) and gate (b) render identically.

**`wd-1` was never built** — `tools/test-wallet/deviations/` holds only `wd-2.patch` and
`wd-3.patch` — **and building it would not move this wall.** Established by reading wallet-core
0.30.2's compiled API rather than by building an APK and finding out:

- `TrustPolicy.Builder.forVct(String, Action)` **does** exist and `Action` is exactly
  `{ENFORCE, INFORM}`, so the deviation `milestone-2-issuer-trust.md` describes is buildable. That
  much of the register is right — unlike WD-3, which had to be corrected after the method it named
  turned out not to exist.
- But `evaluateIssuerTrust` is referenced by exactly **two** classes in the whole library:
  `ProcessResponse` and `ProcessDeferredOutcome`. Both run when a **credential response is
  processed** — after the token request, after `POST /credential` returns. Gate (b) is the last
  thing that happens, not the first.
- And `OfferResolver`, which is what `resolveDocumentOffer` uses, holds no trust configuration at
  all: its fields are the config, the HTTP client factory, an `IssuerMetadataPolicy` and a cache.

So offer resolution applies exactly two things — the **metadata policy**, which `wd-2` relaxes to
`PreferSigned`, and **`withIssuerRegistration`**, the registration certificate. The wall is in one
of those two. `wd-1` is still needed eventually, to *store* a collected credential; it is not what
is blocking now.

**The registration certificate is the stronger suspect, and it may not need a build at all.** The
app refuses when `walletCoreConfig.isRegistrationCheckEnabled && issuerRegistration.isBlockedForIssuance`
— a **runtime preference**, *Check Registration Certificates*, which `wd-2` does not touch at this
point in the flow (`wd-2`'s effect on that check is in `IssuerCreator`, which runs later). V0
publishes no registration certificate (B3). If that preference is on, W4 refuses here whatever the
build carries. Its position was never recorded for W4, and the wallet's DataStore is Tink-encrypted
so it cannot be read over `adb`. **Next action: check that toggle on the phone, then re-send.**

---

## What just happened, and what it did not

**A modified wallet completed a presentation against the platform**, 13 September 2026:
`VERIFIED`, result `{"over_18": false}`, with no `birthdate` in it. The whole chain works —
policy to DCQL, signed request object over public HTTPS, encrypted response, verification,
result policy, derived claim. Recorded with its evidence in
[`reference-wallet-testing.md`](reference-wallet-testing.md) §8.1b.

**It says nothing about an official build.** That wallet carries WD-3 and consults a list we
publish; an unmodified one consults only the notified list, which does not carry our anchor.
**Blocker B1 is untouched.**

## The next action — to be chosen

Nothing is half-done and nothing is blocking. The candidates, in the order I would take them:

0. **A session is now four commands, not eight.** `./scripts/test-session.sh up | present
   <policyId> [--wallet <package>] | status | down`. Every check in it is one of the three mistakes
   made by hand on 13 September, and it reports **all** of them before deciding, rather than dying
   on the first: a `request_uri` that is not public, a `client_id` that is not the development CA's,
   and a window too short to reach a phone. It refuses to send to a phone when any of them holds.
1. **Close the test session** (`./scripts/test-session-tunnel.sh down`, or `test-session.sh down`)
   if it is still open. A
   tunnel is not left running, and the access certificate's SAN carries today's hostname, so the
   next session needs one command to reissue the leaf — the CA is reused, so the wallet build stays
   valid.
2. **The §7.3 PID-during-issuance flow, against the wallet.** Exercised at the platform and engine
   layer (`smoke-issuance.sh`, and the adapter contract test that decodes the nested request object
   as far as a wallet would read it). What is untested is the wallet's half. **Needs the phone.**
   A22 is fixed, so this now tests the flow rather than a coincidence of this stack's configuration.
3. **Why W4 stops at the authorization-code start.** Built and run — `wd-2,wd-3` gets past gate (a),
   and the platform now emits a correct, reachable gated offer. The Wallet reads the offer and the
   metadata and then does nothing, with no request and no logged error. The §7.3 eligibility
   presentation is still unexercised, and the remaining gap is on the wallet side.
   [`reference-wallet-testing.md`](reference-wallet-testing.md) §8.1d.
4. **Decide whether to merge PR #6.** It is open against `implementation/platform-v0-issuance` and
   carries [its description](pr-6-description.md) as of 13 September 2026. The branch was reviewed to
   write that description, and the pass is what found A23.

   **This file does not recommend the merge either way.** The honest question under it is whether
   anyone else reviews the branch: if not, that pass is all the review it will get, and that is worth
   knowing before rather than after. Migration 0006 clears data on any database it reaches.
5. ~~`pnpm db:migrate` and `pnpm api:openapi`~~ **Written, 13 September 2026.** Both scripts named
   files that did not exist. `db:migrate` applies the checked-in migrations on purpose and reports
   what it did — which matters now that 0006 changes data. `api:openapi` writes the business API's
   contract to [`openapi.json`](openapi.json), 32 paths, so a route that changes shape is visible in
   a diff rather than only in a hundred decorators. It needs `DATABASE_URL` and `ENGINE_BASE_URL`
   set, though it contacts neither.

## The two blockers, and which one moved

**B1 — no trusted access certificate.** Still open, and it now has **two independent causes**. The
original one is unchanged: a self-signed certificate cannot work, because a Wallet Unit accepts only
anchors from the notified LoTEs (`AS-WP-06-005` / `RPA_04`). The new one is that the route to fixing
it is also closed — see C10 below. So Path A is unavailable and **Path B is the route**, which is why
the wallet build and the trust list described below exist.

**B5 — public HTTPS.** Was closed on the previous machine; the tunnel died with it and the hostnames
are gone. It is open again *operationally* and reopening it is a matter of running the tunnel, not of
solving anything.

**A22 is fixed, and it is what made §7.3 worth testing.** The eligibility presentation used to be
provisioned on the Relying Party Instance's engine tenant, lazily, with that Relying Party's access
certificate — while the issuer resolved it on the Attestation Provider's tenant, at provisioning,
with no certificate of its own. All three worked here only because `rpi-1` serves both roles. The
provider now takes its own access certificate (migration 0007), and the issuer writes the
presentation configuration itself. Verified live through the platform API, not just the adapter:
`interop-findings.md` A22.

**A20 is fixed, and it was bigger than recorded.** The engine's `POST /issuer/config` is
tenant-scoped, and the platform was writing three tenant-level fields from whichever credential type
happened to be provisioning. So every issuance overwrote the last one's authorization servers, and
the Credential Issuer's **Wallet-visible name** was the last credential type's — the live stack
announced an issuer called "Employee badge". The third field is the registration certificate, which
is trust gate (a). The issuer configuration is now composed from the Attestation Provider, one engine
tenant serves one provider (migration 0006, which found **four** sharing `rpi-1` here), and
`DELETE …/attestation-providers/{id}/provision` releases a reference so the rule is not a one-way
door. Details and the two corrections to the original finding: `interop-findings.md` A20, and the new
A21.

**B7 — issuance to a wallet. Now observed, not inferred.** A modified wallet (W3, `wd-3` only) was
sent a §7.3 PID-gated credential offer over the tunnel on 13 September 2026 and refused on screen:
*"This issuance request has been blocked because the provider could not be verified by your Wallet.
Your personal information or other data has not been shared with this provider."* The Wallet asked
for the metadata as `Accept: application/jwt; application/json` and the engine served unsigned JSON —
which is `interop-findings.md` A15 in one header. Everything upstream worked first time over public
HTTPS. Recorded with the exchange in [`reference-wallet-testing.md`](reference-wallet-testing.md)
§8.1c.

**So the §7.3 presentation half is unreachable from here.** The Wallet blocks before it, and says so.
Going further needs a wallet built with `wd-1` and `wd-2` — and `wd-2` silently disables the issuer
registration-certificate check (`CLAUDE.md` §6.21), so a pass obtained that way proves less again.

---

## What today established, with evidence

| | |
|---|---|
| **The Registrar cannot issue a certificate** | `POST /intended_use/create` reports `201 … created successfully`, returns a `null` id and persists nothing. Four attempts, different payloads. Ownership validation works, so the failure is after it and silent. Full diagnosis: [`interop-findings.md`](interop-findings.md) **C10**. Defect report drafted, **not filed**: [`upstream/registrar-intended-use-not-persisted.md`](upstream/registrar-intended-use-not-persisted.md) |
| **`providerType: WALLET_PROVIDER` is accepted** | Answers `registration-session-plan.md` §3.1 as far as acceptance goes. Nothing says it is semantically right |
| **`hash_pid` identifies the wallet installation, not the person** | **Answered 13 September 2026.** Two different credentials with different attributes, issued into the same wallet, return the **same** `hash_pid`; the same credential twice returns the same value; a different wallet returns a different one. So re-issuing the PID is safe and the form values are irrelevant — but the **W1 installation is irreplaceable**, now by measurement. `interop-findings.md` **C11**, method and the four digests in [`certificate-intake-runbook.md`](certificate-intake-runbook.md) |
| **WD-3 as the register described it cannot be built** | `EtsiTrustConfigBuilder` has no method that adds an anchor. Corrected in [`../tools/test-wallet/deviations.md`](../tools/test-wallet/deviations.md) |

---

## The partial registration at the Registrar

Real records exist under the authenticated session and are recorded in the session state file
(`~/.edtp/registration/state.json`), so the chain **resumes from step 9** if the route is ever fixed:

```
law 253 · legal person 244 · identifier 248 · legal entity 236
policy(wrp) 435 · provider 235 · credential 335 · policy(intended_use) 436
```

`hash_pid` is live in `~/.edtp/registration/hash_pid`, mode 600. **Treat the W1 wallet installation
as irreplaceable** — measured, not assumed (C11): it is the installation the value tracks, and there
is no account, no key rotation and no recovery at that service. The **PID inside it is not** precious
and can be re-issued freely, which matters because it expires 11 December 2026.

---

## Path B, as built

| Artefact | Where | Note |
|---|---|---|
| Development Access CA | `~/.edtp/dev-access-ca/` | Two-level chain. `TEST` only. CA fingerprint `3A:D0:30:F5:71:64:BD:9A:…` |
| TEST trust list | published at `https://ssanchocanela.github.io/european-digital-trust-platform/lote/WRPACProviders.jwt` | 8 anchors: the 7 notified ones **byte-identical** plus ours, which is what makes WD-3 additive rather than a replacement. Branch `gh-pages`. Regenerate with `scripts/make-test-lote.mjs` — **`NextUpdate` 11 December 2026** |
| W2 wallet (release) | installed as `eu.europa.ec.euidi.edtptest2` | Deviation `wd-3`. Writes **no application logging** — release builds set Ktor to `LogLevel.NONE` |
| W3 wallet (debug) | installed as `eu.europa.ec.euidi.edtptest3` | Deviation `wd-3`, logs the HTTP exchange, `run-as`-readable. **This is the one that completed a presentation.** Holds a test PID whose date of birth is the day it was issued |

**WD-3 is settled and needs only one configuration point.** The wallet's built-in JWS verifier
accepts our self-signed list signer — `LoTE JWT signature verified successfully` — so
`jwtSignatureVerifier` is not required, unlike WD-1. What did block it was structural: our entity
lacked `TEAddress`, and the generator now clones the notified list's entity rather than writing one
by hand, so fields nobody has identified as load bearing come along anyway.

**Any result from that wallet is a result from a modified wallet.** Its own banner says
`deviations: wd-3`. It says nothing about whether an unmodified wallet would accept our certificates
— it would not, which is the entire reason it exists.

---

## Running state on this machine

`pnpm verify` passes: **282 unit, 115 integration**. **A note on the pattern**: three separate
defects today (A20, A22, A23) were one tenant-scoped engine object with two owners. Anything that
writes to the engine by a shared identifier is worth checking against that. The adapter contract suite is separate and
needs a reachable engine: `ENGINE_BASE_URL=… ENGINE_TENANT_CREDENTIALS=… pnpm test:adapter` — 25
tests, all passing against the live engine on 13 September 2026. Docker stack up, with a tenant and credentials
in `~/.edtp/smoke-credentials.json`. Console at `http://localhost:3200` via `pnpm console`.

Two published policies, and the difference matters. `f7013836-…` belongs to the smoke test's
service, whose instance holds a **self-signed** certificate no wallet will accept.
**`30627f9a-3e6b-4d56-89ed-3e9b1e0af801`** belongs to the service provisioned with the development
CA's certificate, and is the one a wallet test must use — `test-session.sh present` now refuses the
other one rather than leaving it to be discovered on the phone, and the console's picker names the
Relying Party Service beside each policy so the two are told apart before anything is started.

**The platform cannot show which certificate an instance holds.** It lives in the engine and
`RelyingPartyInstance` keeps only an opaque `engineTenantRef`. The Service name is the closest
honest proxy, which is why both the script and the console stop at it — the script can go further
only because it reads the `client_id` back out of a presentation it already created. There is no route to replace an instance's
certificate — `POST …/instance` creates, and nothing updates — which is why a second service exists
rather than the first being corrected.

Android toolchain complete: JDK 17, SDK `android-37.0` with build-tools `37.0.0`, upstream cloned at
the pinned tag with all three patches applying cleanly. `adb` is Windows' at
`/mnt/c/platform-tools/adb.exe` — WSL2 has no USB passthrough.

The wallet signing keystore is at `~/.edtp/wallet-signing/`. It is **new**: the previous one did not
survive the move between machines, so nothing signed by the old key can be updated in place.

---

## The console now covers both services

**Verification** — offers list, a builder bounded by what the Relying Party registered, and per-offer
monitoring with the QR or same-device link.

**Issuance** — what this tenant offers to issue, a credential offer per policy, and the register of
what was actually collected with revoke, suspend and reinstate. **The trust gate is at the top of
every issuance screen**, because today it does not open: the engine signs no issuer metadata (B7), so
no wallet can complete a collection and the register stays empty however many offers are created. A
console that showed offers without saying so would let an operator hand out a link and learn from a
user that nothing works.

**All eight planned screens now exist.** Services shows what each registered and whether it holds an
access certificate; Audit shows one presentation's trail, evidence only; Tenant shows what this
credential can see and says why tenant creation is not there — it needs the admin key, and the
console deliberately holds only a tenant key.

The registry screens are **read-only on purpose**. A Service and its intended use record an
authorisation, and a creation form would make that look like ordinary configuration while omitting
the registration it stands for.

## mdoc: it works, and revocation checking does not

**The first mdoc presentation against this platform came back `VERIFIED`** on 13 September 2026 — an
mDL, `{"org.iso.18013.5.1.family_name": …}`. Everything before it had been SD-JWT VC.

**It had status checking disabled, and that is not a detail.** The engine cannot decode the reference
issuer's status list: it requires `aggregation_uri`, which `draft-ietf-oauth-status-list-13` marks
OPTIONAL and the issuer does not send. `statusCheckMode: BEST_EFFORT` fails identically — the decode
throws before the mode is consulted — so an mdoc presentation today either turns revocation checking
off, which `VCR_13` allows only after a risk analysis V0 has not done, or it fails.

`interop-findings.md` **A25**, with a defect report drafted and unfiled. The platform's own defect
found on the way, **A24**, is fixed: mdoc values come back without the namespace the claim path
addresses, so a verified presentation was being reported as `POLICY_NOT_SATISFIED`.

## The credential catalogue

Five credentials are registered and offered by the console: PID and mDL, read from the reference
issuer's own metadata, and three **Power of X** attestations — representation, attorney, employee —
from a consortium Rulebook draft.

**The Power of X definitions are not in this repository** — they derive from a consortium Rulebook
draft whose content stays outside it, and the registration script loads them from a file the operator
supplies. What *is* recorded is the part that is ours: the claim paths are an interpretation and the
`vct` values are project-scoped, because the Rulebook gives neither a schema nor a `vct`.
[`credential-catalogue.md`](credential-catalogue.md) says so, and says that when the schema arrives
the paths change and every policy built on them needs republishing.

One difference worth knowing before writing an age policy: the **mDL carries `age_over_18` and the
PID does not**. The same question takes two different policies.

## Open decisions

- ~~**File the Registrar defect report?**~~ **Decided 13 September 2026: parked, not filed.** All six
  reports in [`upstream/`](upstream/) stay as drafts; what to do with them is the repository owner's
  call and is not a task a session should keep re-proposing. If it is ever picked up, the report says
  what to check first: the observation is one afternoon's, and a silent server-side failure is the
  kind of thing that gets fixed without an announcement — so retry the call before sending anything.
- ~~`pnpm db:migrate` / `pnpm api:openapi`~~ — **resolved 13 September 2026**, both written rather
  than removed.
