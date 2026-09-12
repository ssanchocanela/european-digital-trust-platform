# Where the work stands

Written 12 September 2026. **The one page to read after `CLAUDE.md` when picking the work up.**

Everything here is state that the code and the git history do not make obvious: what is in flight,
what is blocked and why, and what the next action is. Findings live in their own documents and are
linked rather than repeated.

---

## The next action

**Open a test session with a tunnel and put a presentation in front of the W2 wallet.** That single
run answers three open questions at once, and nothing else can answer them:

1. whether the modified wallet fetches our published trust list,
2. whether it accepts that list's signature — the open half of WD-3, below,
3. whether it then accepts our development access certificate.

Everything it needs is built and installed. The sequence is
[`test-session-gateway.md`](test-session-gateway.md) §4, and the ordering constraint there is not
optional: `ENGINE_PUBLIC_URL` and `PLATFORM_PUBLIC_URL` must be set **before** `docker compose up`,
because the engine bakes them into every URL it emits. Run the nine negative checks before the phone
touches anything; a `401` on any of them is a failure, not reassurance.

`cloudflared` is not installed yet. It is the only missing piece.

---

## The two blockers, and which one moved

**B1 — no trusted access certificate.** Still open, and it now has **two independent causes**. The
original one is unchanged: a self-signed certificate cannot work, because a Wallet Unit accepts only
anchors from the notified LoTEs (`AS-WP-06-005` / `RPA_04`). The new one is that the route to fixing
it is also closed — see C10 below. So Path A is unavailable and **Path B is the route**, which is why
the wallet build and the trust list described below exist.

**B5 — public HTTPS.** Was closed on the previous machine; the tunnel died with it and the hostnames
are gone. It is open again *operationally* and reopening it is a matter of running the tunnel, not of
solving anything.

**B7 — issuance to a wallet.** Untouched today. Unchanged and still blocked by the engine, which
produces no `signed_metadata` (`interop-findings.md` A15).

---

## What today established, with evidence

| | |
|---|---|
| **The Registrar cannot issue a certificate** | `POST /intended_use/create` reports `201 … created successfully`, returns a `null` id and persists nothing. Four attempts, different payloads. Ownership validation works, so the failure is after it and silent. Full diagnosis: [`interop-findings.md`](interop-findings.md) **C10**. Defect report drafted, **not filed**: [`upstream/registrar-intended-use-not-persisted.md`](upstream/registrar-intended-use-not-persisted.md) |
| **`providerType: WALLET_PROVIDER` is accepted** | Answers `registration-session-plan.md` §3.1 as far as acceptance goes. Nothing says it is semantically right |
| **`hash_pid` across a re-issued PID: still unknown** | The run was **inconclusive, not negative** — the issuer has the operator type the attributes at issue time and the second issuance used different values. See the note in [`certificate-intake-runbook.md`](certificate-intake-runbook.md). Re-testing needs identical form values, and is still free while nothing is registered |
| **WD-3 as the register described it cannot be built** | `EtsiTrustConfigBuilder` has no method that adds an anchor. Corrected in [`../tools/test-wallet/deviations.md`](../tools/test-wallet/deviations.md) |

---

## The partial registration at the Registrar

Real records exist under the authenticated session and are recorded in the session state file
(`~/.edtp/registration/state.json`), so the chain **resumes from step 9** if the route is ever fixed:

```
law 253 · legal person 244 · identifier 248 · legal entity 236
policy(wrp) 435 · provider 235 · credential 335 · policy(intended_use) 436
```

`hash_pid` is live in `~/.edtp/registration/hash_pid`, mode 600. **Treat the W1 wallet and the PID
inside it as irreplaceable** until the identical-values test says otherwise: there is no account, no
key rotation and no recovery at that service.

---

## Path B, as built

| Artefact | Where | Note |
|---|---|---|
| Development Access CA | `~/.edtp/dev-access-ca/` | Two-level chain. `TEST` only. CA fingerprint `3A:D0:30:F5:71:64:BD:9A:…` |
| TEST trust list | published at `https://ssanchocanela.github.io/european-digital-trust-platform/lote/WRPACProviders.jwt` | 8 anchors: the 7 notified ones **byte-identical** plus ours, which is what makes WD-3 additive rather than a replacement. Branch `gh-pages`. Regenerate with `scripts/make-test-lote.mjs` — **`NextUpdate` 11 December 2026** |
| W2 wallet | `tools/test-wallet/out/*.apk`, installed as `eu.europa.ec.euidi.edtptest2` | Deviation `wd-3`. Installed **alongside** W1, which must not be disturbed |

**The open half of WD-3:** whether the library's built-in JWS verifier accepts our self-signed list
signer. `EtsiTrustConfig.customJwtSignatureVerifier` defaults to `null` and what the built-in one
requires was not established. If it refuses the list, WD-3 needs a second configuration point,
`jwtSignatureVerifier` — the same "two points, one alone does nothing" shape as WD-1. Anticipated in
the deviation register rather than left to be discovered as a surprise.

**Any result from that wallet is a result from a modified wallet.** Its own banner says
`deviations: wd-3`. It says nothing about whether an unmodified wallet would accept our certificates
— it would not, which is the entire reason it exists.

---

## Running state on this machine

`pnpm verify` passes: **268 unit, 92 integration**. Docker stack up, with a tenant, a published
policy (`f7013836-7656-402b-9745-b762acfea774` v1) and credentials in
`~/.edtp/smoke-credentials.json`. Console at `http://localhost:3200` via `pnpm console`.

Android toolchain complete: JDK 17, SDK `android-37.0` with build-tools `37.0.0`, upstream cloned at
the pinned tag with all three patches applying cleanly. `adb` is Windows' at
`/mnt/c/platform-tools/adb.exe` — WSL2 has no USB passthrough.

The wallet signing keystore is at `~/.edtp/wallet-signing/`. It is **new**: the previous one did not
survive the move between machines, so nothing signed by the old key can be updated in place.

---

## Open decisions

- **File the Registrar defect report?** Drafted and unfiled; filing is outward-facing.
- **The policy picker in the Test driver.** That screen still says the platform API has no list
  route. It has had one since web phase B1, which is why a policy UUID has to be typed by hand.
- **`pnpm db:migrate` and `pnpm api:openapi` point at files that do not exist.** Pre-existing; the
  first is a rename, the second needs a decision about what it should do.
