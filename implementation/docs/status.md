# Where the work stands

Written 12 September 2026, updated 24 September. **The one page to read after `CLAUDE.md` when picking the work up.**

Everything here is state that the code and the git history do not make obvious: what is in flight,
what is blocked and why, and what the next action is. Findings live in their own documents and are
linked rather than repeated.

---

## 24 September 2026, night — **a representation credential from the wallet's own list, issued as CORPME after identifying with the PID**

W6, now listing two issuers (WD-5 with `pid-1,rpi-1`), requested *Poder de representación* — and then
*Poder notarial* and *Autorización de empleado*, the same way — from
*CORPME (demo)*. The hosted form (CORPME look) had the person present their PID from the same wallet
**mid-issuance**, came back through the platform, showed what the attestation would say, and issued it:
presentation `VERIFIED`, issuance `ISSUED`. Personal data from the PID; organisation, position and powers
fixed and fictitious. PoX types at **v2** with Spanish names; `rpi-1` advertises only them. Record:
[`reference-wallet-testing.md`](reference-wallet-testing.md) §8.1m; gate and return: `test-session-gateway.md` §1e.

**The one-use limitation is removed (24 September).** A PID was spent by its first presentation: the
pinned wallet stores a PID as once-only, and the engine cannot serve it a batch (A34 — a key
attestation must carry exactly one key). An issuance policy version now carries an optional
`reusePolicy` (ARF Method B, limited-time), published as `credential_reuse_policy`; Wallet Core applies
it with no wallet change. PID at **v5**, PoX at **v4**; one PID presented twice, both `VERIFIED`
(§8.1n). (PID v4 and PoX v3 copied the **v1** by mistake — `GET …/issuance-policies/{id}` lists
versions newest first, and a script took the last element as the latest. Superseded and withdrawn;
name the version to copy, never infer it from list order.) The linkability cost is recorded in A34. The better fix, once-only batches, needs EUDIPLO to
accept a multi-key attestation proof: draft issue in `docs/upstream/eudiplo-batch-attestation-proof.md`,
**not filed** — awaiting review.

**The test PID now follows the PID Rulebook (24 September).** Policy **v7**, a new type from
`scripts/pid/pid-rulebook-sd-jwt.json`: every attribute and metadata item of PID Rulebook v1.1 in its
SD-JWT VC encoding (§4.1, catalog commit `36f8adcf`, identical to `main`), 28 claims, with a payload
schema for what a claim list cannot say — alpha-2 codes, dates, the `sex` code list. Mandatory as
CIR 2024/2977 makes them, plus two **we** require where the Rulebook does not: the **ID number** (left
to the Member State, §2.3) and the **country of birth** (§4.1 accepts any one of country, region or
locality). Stricter than the Rulebook, never looser. (v6 had the country optional; superseded.)
The portrait is not included: it is not yet mandatory, and `PID_03a` restricts its retention.
`attestation_legal_category: "PID"` and `trust_anchor` (our TEST PID list) are fixed. The FNMT form shows
the identity first and folds residence/contact and document data away. Applied by
`scripts/upgrade-test-pid-type.mjs`; **not yet issued to a phone**.

**A demonstration bank for the representation credentials (24 September).** `apps/demo-bank`, "Banco
Demo" — fictional, generic look, demonstration band — asks the wallet for a Power of Representation, a
Power of Attorney or an Employee Authorisation to authorise a fictitious company transfer, and shows the
outcome and the verified claims. Platform side: `/v1/hosted-verifications`, one narrow secret, return
destination set by the platform (P7). **Run on the phone**: one Power of Representation presented
twice, both `VERIFIED` (§8.1o) — the representation credentials are reusable. The PID was re-issued under
v7 first. *Poder notarial* and *Autorización de empleado* at the bank: both `VERIFIED` too. If the phone cannot
open a new hostname, the home router is caching it as nonexistent: use Private DNS (`one.one.one.one`)
or mobile data.

**The permanent demonstration environment — ADR 0010 accepted, the VM exists (24 September).**
`edtp-demo`: Hetzner `cx23`, `fsn1`, Ubuntu 24.04, hardened by cloud-init (`infra/demo-vm/`), with Docker
and `cloudflared` installed. Its own tunnel `edtp-demo` runs as a service. SSH works only through
`edtp-ssh.murcata.es`, behind Cloudflare Access; the Hetzner firewall has **no inbound rules**.
**Live since 24 September**: the laptop's state was migrated (databases, configuration, TEST CAs), the
five demo hostnames moved to the VM's tunnel, and the public negative checks pass (26 of 26 are `404`).
**Laptop sessions no longer own those hostnames.**

**Step 2 deployed (24 September): the public environment is generic.** The image is `b9e53af89eac`
and the `generic` profile is on. The issuers are "PID Demo Issuer" and "Registro Demo" with no logo.
PID policy **v8** has the label "PID (demo)" and the issuing authority "EDTP PID Demo Issuer (TEST
ONLY)". The form shows the neutral "EDTP Demo" look. The negative checks pass.

Since then:
- Cloudflare's cache kept serving the FNMT/CORPME images for hours after the origin had stopped. The
  cache was purged, and all four now answer `404`. They are served `no-store` since image
  `b9e53af89eac`, deployed on 24 September.
- **`edtp-cliente.murcata.es` is behind Access** (an unauthenticated request gets `302` to the login)
  and is **in the VM tunnel**. It was added only after the protection was seen working. A client profile
  can now be switched on with `demo-profile.sh fnmt-corpme`, with the organisation's written permission
  first.

**The portal is live (24 September): `https://demo.murcata.es`**. It has four
cards:
- test PID;
- representation credential;
- Banco Demo;
- **Tienda Demo's age check** (`https://edtp-banco.murcata.es/edad`). It returns `over_18` only; its
  policy `eb1f5c2b` was created on the VM.

`/operador` is behind Access (`302` to login) and also refuses without Access's identity header. The
negative checks now probe the portal too: 32 of 32 are `404`.

**Per-client rate limits deployed (image `826cf841d5f4`).** Tested on the VM:
- 305 gateway requests from one client: 300 passed, 5 got `429`, and a second client was unaffected;
- 12 bank POSTs: 10 were processed, 2 got `429`.

The Cloudflare edge rule "EDTP demo - flood" was created by a person: 100 requests per 10 seconds per
IP, then a 10-second block (the only rule the free plan allows). Tested on 24 September: in a burst of
130 requests to the portal, which has no limit of its own, 110 passed and then `429` with
`retry-after: 9`; access was back after about 10 seconds. Security limitation P8.

**Scheduled checks and nightly reset installed (24 September, image `bbbfbe5258f0`).**
- The negative checks run every 15 minutes. **An exposure stops the tunnel**; the last result is shown
  on `/operador`.
- The nightly reset runs at 03:30 Europe/Madrid: generic profile, application containers recreated,
  images pruned. The databases and the engine are never touched.
- A manual run of each passed.
- Alerts go to the journal and to a private ntfy.sh topic (the operator's phone). The topic name is not
  in the repository.

See `infra/demo-vm/README.md`, including how to get back in after a fail-closed stop.

Still open:
- The W6 wallet still labels the PID row "PID - FNMT", which is compiled in. A W7 with "PID (demo)" is
  optional.

**Next — batch once-only issuance upstream.** Decided: file the issue
(`docs/upstream/eudiplo-batch-attestation-proof.md`, with the user for review), and if the maintainers
accept it, prepare the PR from a personal fork outside this repository (CLAUDE.md §1 exception). The
engine stays the pinned image.

**Always open a form session with `GATEWAY_PINNED_WALLET_COMPAT=true`** — without it the list fails
(A29 item 3); the script now refuses.

## 24 September 2026 — **a PID requested from the wallet's own list, for an FNMT demonstration**

Wallet-initiated issuance works end to end with **W6** (WD-5: the wallet's *From list* offers only our
`pid-1`, row "PID - FNMT"): the wallet pushes an authorization request, the test gateway sends the
browser to the **hosted form** (`apps/pid-form`, `edtp-pid.murcata.es`, FNMT-styled with a
demonstration band), the platform validates and holds the values in memory, and the engine fetches them
through the platform's **attribute provider** when the wallet collects the PID. The issuer shows as
*FNMT-RCM (demo)* with the FNMT emblem. PID policy is at **v3** (ID number mandatory), provisioned ahead
with `POST …/issuance-policies/{id}/provision`, which also withdraws earlier versions. Record:
[`reference-wallet-testing.md`](reference-wallet-testing.md) §8.1l; gate: `test-session-gateway.md` §1e;
limits P5, P6, V4.

**Next, agreed:** the representative credentials from the same list, issued by *CORPME* after
identifying with the PID on a web page.

## 23 September 2026 — **a test PID issuer, built; not yet shown with a wallet**

The agreed next step from the 17th, everything except the phone run:

| Piece | Where | State |
|---|---|---|
| Development PID Provider CA | `scripts/make-dev-pid-ca.sh`, `~/.edtp/dev-pid-ca` | Created. SHA-256 `34:92:7A:65:…:C5:8A:1B` |
| TEST PID list, notified 7 + ours | `https://ssanchocanela.github.io/european-digital-trust-platform/lote/PIDProviders.jwt`, `make-test-lote.mjs --kind pid` | Published, `NextUpdate` 22 December 2026. Loaded on `rpi-1` as `edtp-test-pid-providers`, mapped in `ENGINE_ISSUER_TRUST_LISTS` |
| *Identify with PID* | policy `b022662f…` | **v5**, naming the TEST list. Still accepts a reference-issued PID, because the list carries the notified anchors |
| Deviation **WD-4** (`pidProviders` → TEST list) | `tools/test-wallet/build.sh --deviations wd-2,wd-3,wd-4 --pid-lote …` | Verified with `--prepare-only`. **No APK built yet** |
| Test PID Attestation Provider | engine tenant **`pid-1`** (`scripts/create-engine-tenant.sh`), `scripts/setup-test-pid-issuer.sh`, ids in `~/.edtp/test-pid-issuer.json` | Provisioned, signing under the PID CA; wallet-provider trust loaded on `pid-1` |
| PID credential type | SD-JWT VC `urn:eudi:pid:1`, PID Rulebook §4.1 mandatory set | Published. Claims gained a `string[]` value type for `nationalities` |
| `operator-form` source + console form | `/issuance/<policy>` in the console | Offer + QR created from the console; typed values found in no log and nowhere in the platform database |

**Before recording any result from it, two things:**

1. **Selective disclosure only from 23 September, evening.** Until then the adapter sent no
   `disclosable` flag and the engine signed every claim in the clear (`interop-findings.md` A32) — so
   every credential issued earlier, test PIDs included, discloses everything. Fixed by another session
   and cherry-picked here (`bfbf7c9`, `83f3c78`); the engine's stored configuration for the test PID
   now marks all eight fields disclosable. **Not yet shown on an issued token**: the wallet run must
   decode one and count its disclosures before any result says it is selectively disclosed.
   W5 (`eu.europa.ec.euidi.edtptest5`, debug, `wd-2,wd-3,wd-4`, APK SHA-256 `5c830bdc…5ea0`) is built.
2. The PID Rulebook at the pinned catalogue commit `36f8adc` carries a change log to **v1.7**, while
   `CLAUDE.md` pins "document version 1.1". Not changed here; worth checking which is meant.

**Next:** build the APK (`wd-2,wd-3,wd-4`, both `--wrpac-lote` and `--pid-lote`, a new
`--app-id-suffix` so W4 survives), bring up the test session, issue a test PID from the console
form, then present it to *Identify with PID* v5. Then the demonstration's first step no longer needs
the reference issuer.

## 23 September 2026, night — **the three Power of X attestations issued to a wallet, selectively disclosed**

The representative credential moved to the Power of X model, all three types: structured credential
types (`integer`, `object[]`, an enforced `payloadSchema` — `bfbf7c9`), a fix to the
verified-presentation source that had only ever worked for one-segment paths (same commit), and
`scripts/register-pox-issuance.mjs`, which reads the out-of-repository definitions and fictitious test
data. [`credential-catalogue.md`](credential-catalogue.md) *Issuing Power of X*.

**Run end to end with W5** ([`reference-wallet-testing.md`](reference-wallet-testing.md) §8.1j): a test
PID from the operator form, identified against *Identify with PID, for a Power of X credential*
(`c4e31d3f…`), then Power of Representation, Attorney and Employee issued from that presentation and
stored. The tokens, read from the debug wallet: **19, 9 and 18 disclosures, nothing in the clear** —
the first attestations from this platform with selective disclosure. The test PID's own token was
consumed by the presentation, so its disclosures are still unseen.

Two of our own defects fixed on the way: retired issuance policies' gates were still compiled, which
since A30 blocked **every** issuance on `rpi-1`; and the tunnel script now ignores
`~/.cloudflared/config.yml`, whose catch-all `404` (another project's) swallowed every request.

**Verified too, and across sessions** (§8.1k): one presentation policy per `:2` type, an intended use
registering them, and the **EDTP TEST list of non-qualified EAA providers** as issuer anchor, published on
GitHub Pages and loaded as `edtp-test-eaa-providers`. All three `VERIFIED`, and a Power of
Representation issued in one session verified again in the next. Sessions now run on the named tunnel
`edtp-dev` (`edtp-engine|platform|start.murcata.es`), because an attestation's status list URI is the
engine's public URL at issue. On the way: A33 — the engine signed the tenant's status list with an
expired key it had chosen by fallback; the adapter now pins the list to the provider's key.

**Next:** the test PID's own disclosures on a token are still unseen; and requesting credentials from
the application's dashboard, starting with the PID.

## 17 September 2026 — **presentations now check who signed what was presented**

Found while starting a test PID issuer: the engine reports a presentation verified **without any issuer
trust check** when the policy names no trust list, and the platform never passed one
([`interop-findings.md`](interop-findings.md) A30). Fixed, failing closed — a policy with no loaded list
is refused. The notified dev PID list is loaded on `rpi-1` and *Identify with PID* is at **v2**, naming
it. Also A31 (`VP_REMOVE_TA`) and security limitation K3a.

**To reproduce on a fresh engine database:** `node scripts/load-issuer-trust-list.mjs --tenant rpi-1
--lote https://trustedlist.serviceproviders.eudiw.dev/LOTE/json/PIDProviders.jwt --signer-sha256
2IMmoFLUHyrtG60cldjIwVrvsEonpHlw9NhOqlfYUSo --id eudi-dev-pid-providers`, then the printed pair into
`ENGINE_ISSUER_TRUST_LISTS`. The console's offer builder now requires choosing a list.

**Shown with a wallet, 18 September:** the same reference-issued PID verifies under the check (policy
v2) and is refused as `trust_chain_not_trusted` against a list holding the wrong anchor (v3, a negative
control since removed). §8.1i. *Identify with PID* is now at **v4**, naming the notified dev PID list.

**Next, agreed:** a test PID issuer with a form — a development PID CA, a TEST PID list (notified
anchors plus ours) loaded into the engine and published for the wallet, deviation WD-4 (`pidProviders`
pointing at that list), the PID credential type, a form-backed source and its console page.

## 16 September 2026, night — **the end-to-end demonstration works**

Present a PID, be identified, be issued a representative credential built from it, and hold it in the
wallet. Four steps, one wallet, one tenant: [`reference-wallet-testing.md`](reference-wallet-testing.md)
§8.1g, and every limit from §8.1f still applies. The representation is fictitious by construction.

**Steps 2 and 3 are in the console, and were run from it** (§8.1h): a verified presentation page
offers issuance from it, and the builder sets fixed values and the maximum presentation age. Step 1 —
obtaining the PID — is still the EUDI reference issuer's own form, not this platform.

## 16 September 2026, evening — **a wallet collected an attestation from this platform**

The first time since the issuance side existed. A modified wallet (W4) collected *Employee badge*
over the tunnel and stored it; the platform recorded it `ISSUED` and it is revocable from the console.
Evidence and every limit: [`reference-wallet-testing.md`](reference-wallet-testing.md) §8.1f.

**To reproduce**, all of these — and the fourth is the one that failed twice on the day:

1. `ENGINE_WALLET_PROVIDER_TRUST_LIST_ID=eudi-dev-wallet-providers` in `.env`, and
   `./scripts/setup-wallet-provider-trust.sh` once per engine database.
2. The gateway with **`GATEWAY_PINNED_WALLET_COMPAT=true`** — e.g.
   `GATEWAY_PINNED_WALLET_COMPAT=true ./scripts/test-session.sh up`. A demo workaround (A29).
3. **The host clock in sync with real time.** The client-attestation check runs with zero tolerance
   (A29); two seconds off fails the token request intermittently.
4. **After restarting Docker, re-apply the session environment** before trusting any offer:
   `set -a; . /tmp/edtp-test-session/session.env; set +a; docker compose up -d --force-recreate eudiplo platform-api operator-console test-start`.
   Twice today a plain `up` put the engine back on `localhost` and every offer became unreachable.
5. **Cold-start the wallet** before sending an intent (`am force-stop`), or scan the QR from the
   wallet's own scanner. An intent delivered to a wallet already open is dropped.

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
not the question — any engine failure reproduces it. **Settled later the same day**: the ordering is
kept, and the record now distinguishes intended from in effect — `status_confirmed_at`, migration
0009, shown in the console as *"not in effect"*. No retry queue; the call is idempotent.

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

### A policy can be retired, which the platform had modelled and could not do

Tidying the development tenant — eight issuance policies, most of them debris from three days of
debugging — turned out not to be tidying. **There was no way to retire an issuance policy.**
`POLICY_CONTAINER_STATUSES` has carried `RETIRED` since Milestone 1 and the presentation service has
refused a retired policy since then, but **no route on either side ever set it**, so that check had
never had anything to refuse. The issuance side's own type called the state `ARCHIVED` — a second
name for a state no row had ever held, which is how a naming drift survives: nothing could produce
the value, so nothing could disagree about it.

`POST …/issuance-policies/{id}/status` now sets it, the issuance service refuses a retired policy
the way the verification side always has, and the console shows retired policies in their own
section rather than mixed into the working list. **Reversible on purpose**, and the contrast with
revocation is the reason: `AS-AP-07-007` makes an attestation's revocation irreversible because it
is a statement about a credential somebody holds, while retiring a policy only stops new
transactions starting — attestations already issued keep the terms they were issued under. Deleting
is not offered at all: an attestation referencing a policy that had vanished would be unexplainable.

The development tenant is now two live policies and six retired, done through the console.

**The verification side has the identical gap** — a presentation policy cannot be retired either,
and `presentation.service.ts` has been enforcing `policy_retired` against a state nothing can set.
Not fixed here, because it was not what was asked; recorded because it is the same hole.

### And there is now a script for showing it to someone

[`demonstration-script.md`](demonstration-script.md). What can be demonstrated, in what order, what
each run evidences and what it does not — and a table of **sentences that would be untrue**, which
is the half that matters. "Tested with the EUDI Reference Wallet" is the first row: the modified
wallet exists precisely because an unmodified one refuses this platform's certificates, so a result
from a build changed to stop refusing says nothing about the build that refuses.

The honest story is three sentences, and the third is the finding rather than a caveat: verification
works against a real wallet; issuance works end to end to a conformant client; **no wallet can
collect the attestation, and the reason is not in this platform**.

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
