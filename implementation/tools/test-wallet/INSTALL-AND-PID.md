# Sheet 1 — install the test wallet and obtain a test PID

**Purpose: answer the one W0 question that could not be answered by reading code** — will
`issuer.eudiw.dev` issue a test PID to a rebuilt APK with a different `applicationId` and our own
signing key?

This build has **no behavioural deviation**. So if a PID arrives, the identity change is not an
obstacle and every later deviation can be tested on this base. If it does not, we know the obstacle is
identity rather than trust configuration, which is exactly why this is tested before anything else.

**Synthetic data only.** Never put a real identity document, a real photograph or real personal data
into this build.

---

## Before you start

| | |
|---|---|
| Device | A physical Android phone, **API 29+** (Android 10 or later). An emulator works for onboarding but is unreliable for NFC and proximity, which this sheet does not need |
| USB debugging | On, and the computer authorised |
| `adb` | `~/Library/Android/sdk/platform-tools/adb` |
| Official wallet | Optional. If it is installed it will stay installed — the `applicationId`s differ |
| Free space | ~900 MB on the phone |

Build the APK first (`./build.sh`) and keep the build record it prints.

## 1. Install

```bash
export PATH="$HOME/Library/Android/sdk/platform-tools:$PATH"
adb devices                       # confirm exactly one device, and that it says "device"
adb install -r out/edtp-test-wallet-*.apk
```

Expect `Success` after a minute or two; the APK is large.

**Check, on the phone:**

- [ ] The launcher shows **two** wallet icons if the official wallet is installed — ours is named
      `EDTP Test Wallet — modified reference build` (the launcher will truncate it; Settings → Apps
      shows it in full).
- [ ] Opening ours shows a **red banner on every screen**:
      `EDTP TEST WALLET · MODIFIED REFERENCE BUILD · NOT THE OFFICIAL EUDI WALLET · deviations: none`.
- [ ] The official wallet, if installed, still opens and still has its own data.

If the banner is missing, the wrong flavour was installed — stop and check
`adb shell pm list packages | grep euidi`, which must show `eu.europa.ec.euidi.edtptest`.

### If `adb install` fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`

A previous build of the same `applicationId` is installed, signed with a different key — most likely a
debug build (see §5: debug and release share the `applicationId`). Uninstall first:

```bash
adb uninstall eu.europa.ec.euidi.edtptest
```

That deletes that wallet's data, including any PID it holds. It does **not** touch the official wallet.

## 2. Start a log capture before you touch the app

The interesting failure is silent, so capture from before the first launch.

```bash
adb logcat -c                                       # clear
adb logcat -v time > /tmp/edtp-wallet-pid-run.log   # leave running in its own terminal
```

Keep the whole file — not a filtered excerpt. A filter applied before you know what failed usually
removes the line that explains it.

## 3. Onboarding

1. Open **EDTP Test Wallet**.
2. Accept whatever the first-run screens ask (consent, terms).
3. Create a **quick PIN** when asked, and use something disposable.
4. Enable biometrics only if convenient; it changes nothing that matters here.

You should reach the home screen, with the banner on it.

> The wallet treats the PID as its activation document — one of its own strings is *"Wallet needs to be
> activated first with a National ID"* — so the PID step below is onboarding, not an extra.

## 4. Ask for a test PID

1. **Add document** → **From list**.
2. Choose the **PID** entry (the reference configuration offers PID in SD-JWT VC and mdoc form; take
   the SD-JWT VC one if you are offered a choice, since that is the format our platform issues).
3. The wallet opens the reference issuer's authorisation page at `issuer.eudiw.dev`. Complete it with
   the **test credentials that page offers** — it is a test issuer and presents its own synthetic
   options. Do not use a real identity.
4. Approve the offer in the wallet.

Screen wording may differ slightly from the above; the sequence is add → from list → PID → authorise at
the issuer → approve.

**What is actually being tested here, invisibly:** before the token request the wallet fetches a wallet
instance attestation from `wallet-provider.eudiw.dev` and a key attestation for the keys that will hold
the PID, then presents the wallet attestation to the issuer as its client authentication
(`clientId = eudiw-abca`). None of that is visible in the UI. It either works, and a document appears,
or the flow fails — and §6 is how to tell which part failed.

## 5. If it fails

Try these in order, and **record each attempt** — a failure that is understood is the point of this
run, not a waste of it.

| # | Step | Why |
|---|---|---|
| 1 | Note the **exact on-screen message**, with a screenshot | The banner in the screenshot proves which build produced it |
| 2 | Search the log for `wallet-instance-attestation`, `key-attestation`, `wallet-provider`, `issuer.eudiw.dev`, `HTTP`, `401`, `403`, `invalid_client`, `attestation` | Separates "attestation refused" from "issuer refused our attestation" from "something else entirely" |
| 3 | Build and install a **debug** APK for a verbose run | Release sets the HTTP log level to `NONE`; debug sets it to `BODY`, so request and response bodies appear in logcat |
| 4 | Try the **`dev` flavour's** Wallet Provider by building `devRelease` | `dev.wallet-provider.eudiw.dev` may be more permissive than the demo one |

For step 3:

```bash
adb uninstall eu.europa.ec.euidi.edtptest     # same applicationId, different signing key
cd upstream && ./gradlew :app:assembleEdtptestDebug
adb install -r app/build/outputs/apk/edtptest/debug/app-edtptest-debug.apk
```

> ⚠️ A debug build logs **request and response bodies**, which during issuance includes the PID itself.
> That is the wallet's behaviour, not ours, and it is acceptable only because the data is synthetic.
> Delete the log afterwards, and never attach a debug-build log to a document or an issue.

### The distinction that matters most

| Observation | Reading |
|---|---|
| Attestation calls **fail** (`wallet-provider.eudiw.dev` returns 4xx) | The Wallet Provider is refusing an unrecognised installation. W0 found nothing in the request that identifies the app, so this would be a surprise and worth reporting precisely |
| Attestation **succeeds**, the issuer then refuses (`invalid_client`, 401 on the token endpoint) | The issuer is validating something in the attestation we cannot influence by rebuilding. This is the case that pushes us to option B (ask the reference-environment maintainers) |
| Both succeed and the PID arrives | The identity change is not an obstacle. Proceed to WD-1 |

**Do not work around a failure by changing trust configuration.** A PID obtained by relaxing a check in
the wallet proves nothing about whether a rebuilt wallet can be provisioned normally, which is the
question.

## 6. What to record

Fill this in and keep it with the run, whatever the outcome. It goes in
`implementation/docs/test-wallet-runs.md`.

```
Run:                    W1-PID-001
Date (UTC):
Operator:

--- build, from build.sh's record ---
APK SHA-256:
Signing cert SHA-256:
applicationId:          eu.europa.ec.euidi.edtptest
versionName:            2026.09.42-edtptest
Upstream tag:           Wallet/Demo_Version=2026.09.42-Demo_Build=42
Upstream commit:        43f362d2a720edb6d37a356b6a51b52b32c61f25
Wallet Core:            0.30.2
Active deviations:      none
Build type:             release | debug
Platform commit:
EUDIPLO version/digest: n/a for this run — no platform component is involved

--- device ---
Model / Android version:
Official wallet also installed:        yes | no
Registration-certificate check:        default (off) — not used in this run

--- result ---
Installed alongside official wallet:   yes | no
Banner visible on every screen:        yes | no
Onboarding completed:                  yes | no
Wallet instance attestation:           success | failure | not determinable
Key attestation:                       success | failure | not determinable
PID issuance:                          success | failure
PID format obtained:                   SD-JWT VC | mdoc | none
Exact on-screen error (verbatim):
Relevant log lines (file kept at):
Screenshots (paths):

--- conclusion ---
Can a rebuilt APK with our identity be provisioned by the reference environment?   yes | no | partly
If no: which of the two failure modes in §5, and what it implies for options A–D
```

Three fields are deliberately recorded even though this run does not use them — EUDIPLO's digest, the
platform commit and the registration-certificate preference. Every later run needs them, and a record
template that changes shape between runs cannot be compared across them.

## What this run does not establish

- Nothing about our platform. No EUDIPLO, no platform API, no certificate is involved.
- Nothing about either trust gate. Gate (a) needs WD-2 or an engine that signs its metadata; gate (b)
  needs WD-1 and a published list.
- Nothing about the **official** wallet. A PID in this build says the reference environment provisions
  *this* build; blocker **B1** and the Q1a chain check are what decide whether an official build can be
  used for VaaS testing.
