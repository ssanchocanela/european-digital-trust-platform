# Where the work stands

Written 12 September 2026, updated 13 September. **The one page to read after `CLAUDE.md` when picking the work up.**

Everything here is state that the code and the git history do not make obvious: what is in flight,
what is blocked and why, and what the next action is. Findings live in their own documents and are
linked rather than repeated.

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

## Open decisions

- ~~**File the Registrar defect report?**~~ **Decided 13 September 2026: parked, not filed.** All six
  reports in [`upstream/`](upstream/) stay as drafts; what to do with them is the repository owner's
  call and is not a task a session should keep re-proposing. If it is ever picked up, the report says
  what to check first: the observation is one afternoon's, and a silent server-side failure is the
  kind of thing that gets fixed without an announcement — so retry the call before sending anything.
- ~~`pnpm db:migrate` / `pnpm api:openapi`~~ — **resolved 13 September 2026**, both written rather
  than removed.
