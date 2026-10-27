# Handoff — the FNMT-RCM test wallet, on the MacBook Pro

Written 27 October 2026 for a Claude Code session on the Mac, ahead of a testing event where the
Mac is the only machine. That session already handles FNMT-RCM's back-end services. This page gives
it everything it needs to **rebuild the wallet, add a deviation, install it and debug it on the
phone**. Read [`README.md`](README.md) and the top of [`deviations.md`](deviations.md) after it, and
`implementation/CLAUDE.md` §6.22 and §8 before saying anything about a result.

---

## 1. What this wallet is

A **modified build** of the EUDI Reference Implementation Android wallet, built by
[`build.sh`](build.sh) from the pinned upstream tag plus our patches. **Never call it "the Reference
Wallet"**, not in a log line, a slide or a message to FNMT-RCM. No wallet source is committed: the
script clones upstream into `upstream/` (gitignored) and patches it. For several deviations it also
rebuilds two dependencies from source:

- `upstream-etsi/`: the ETSI TS 119 602 library, `eudi-lib-kmp-etsi-1196x2` `v0.4.0-alpha.1`. It
  is rebuilt for WD-10, WD-12, WD-13 and WD-15.
- `upstream-walletcore/`: Wallet Core `v0.30.2`. It is rebuilt for WD-14, WD-16 and WD-17.

Both are published into a local `edtp-maven` repository inside the clone and substituted through
Gradle. All pins are in [`pins.env`](pins.env).

## 2. Repository

| | |
|---|---|
| Remote | `git@github.com:ssanchocanela/european-digital-trust-platform.git` |
| Branch | **`wallet/fnmt-commission-lists`** (WD-12 to WD-20, builds F7 to F15) |
| PR | https://github.com/ssanchocanela/european-digital-trust-platform/pull/41, open, still titled for WD-12 to WD-14. Update its title and body to WD-12 to WD-20 |
| Tooling | `implementation/tools/test-wallet/` |

```bash
git fetch origin && git switch wallet/fnmt-commission-lists && git pull
```

## 3. Mac prerequisites — do this before the event

The build clones **three** repositories from GitHub, and the first build downloads Gradle and every
dependency. **Run one full build at home**, so the event network only matters for the FNMT-RCM
services.

| | |
|---|---|
| JDK | **17**, e.g. `brew install openjdk@17`, then `export JAVA_HOME=/opt/homebrew/opt/openjdk@17`. `build.sh` refuses any other major version |
| Android SDK | platform **37**, build-tools **37.0.0**, platform-tools (`adb`). `export ANDROID_HOME="$HOME/Library/Android/sdk"` |
| Disk | about 10 GB: the wallet clone, both dependency clones, Gradle caches and 380 MB APKs |
| Time | about 7 minutes cold on an M-series Mac. The Wallet Core rebuild with its tests adds several more |

On a network whose TLS proxy the JDK does not trust, see `EDTP_JAVA_TRUSTSTORE` in the README.

### The signing key: the one thing that does not come from git

```bash
export ANDROID_KEYSTORE_PATH="$HOME/.edtp/wallet-signing/edtp-test-wallet.keystore"
export ANDROID_KEY_ALIAS=edtp-test-wallet
export ANDROID_KEY_PASSWORD='…'   # from the password manager; never on a command line in a log, never in a file in the repo
```

**Use the same keystore as the Linux machine**, `~/.edtp/wallet-signing/edtp-test-wallet.keystore`
(created 12 September 2026). Check whether the Mac already has it. If it does not, copy it across by
hand (USB stick or AirDrop): never through git, a chat or an email. An APK signed with a different
key **cannot update** the installed app. The app has to be uninstalled first, which loses the PID and
every credential on the phone. `make-signing-key.sh` creates a new key only as a last resort, for
exactly that reason.

## 4. The two builds

The same deviations go into two identities, so both can sit on one phone:

| | Deliverable | Diagnostic |
|---|---|---|
| `applicationId` | `eu.europa.ec.euidi.fnmtce` | `eu.europa.ec.euidi.fnmtcediag` |
| Name | `FNMT-RCM Cartera demo CE` | `FNMT CE diag` |
| Logs | WD-7: warnings and errors only, **no HTTP bodies** | **HTTP bodies, PID contents included**, plus `EDTP-DIAG` traces from `diagnostics/diag-issuance.patch` |
| Who may have it | FNMT-RCM, on its premises, with its filled-in `DELIVERY-NOTICE.md` (CLAUDE.md §6.22) | **Our own phone only. Never handed to anyone** |

**Latest is F15** (WD-20). Only its **diagnostic** variant has been built and installed (SHA-256
`8f7f959a…`). The deliverable F15 is prepared but **not built**. The last deliverable handed over is
F8. Number the next build **F16**, and add a section for it in `deviations.md` like F10 to F15.

Deliverable:

```bash
cd implementation/tools/test-wallet
L=https://development.trust.tech.ec.europa.eu/lists/eudiw
./build.sh \
  --deviations wd-3,wd-4,wd-6,wd-7,wd-8,wd-10,wd-11,wd-12,wd-13,wd-14,wd-15,wd-16,wd-17,wd-18,wd-19,wd-20 \
  --pid-lote $L/pid-providers.json --wrpac-lote $L/wrpac-providers.json \
  --wrprc-lote $L/wrprc-providers.json --mdl-lote $L/mdl-providers.json \
  --brand fnmt-color --app-id-suffix .fnmtce --app-name "FNMT-RCM Cartera demo CE"
```

Diagnostic: the same **without `wd-7`**, plus `--diagnostics`, `--app-id-suffix .fnmtcediag
--app-name "FNMT CE diag"`.

`--prepare-only` stops after patching. It is the quick way to check that a new patch applies before
paying for a full build. The APK lands in `out/`, and the script prints a build record (SHA-256,
`aapt` identity, `EDTP_DEVIATIONS`, `EDTP_DIAGNOSTICS`). Keep it, because it is what a result is a
statement about.

Verify before installing:

```bash
APK=out/<file>.apk
shasum -a 256 "$APK"
"$ANDROID_HOME"/build-tools/37.0.0/aapt dump badging "$APK" | head -2
```

The deviation list is the `EDTP_DEVIATIONS=` line of the build record. It also appears in the red
banner on every screen of the installed app.

### What the deviations do (one line each; `deviations.md` has the record and the standards analysis)

| | |
|---|---|
| WD-3, WD-4, WD-8, WD-12 | Trust lists: WRPAC, PID, WRPRC and **mDL** read from the Commission's development lists. WD-12 adds the mDL list for `org.iso.18013.5.1.mDL` |
| WD-6 | Credential response encryption `REQUIRED` → `SUPPORTED` (security relaxation) |
| WD-7 | Release build logs no HTTP bodies (deliverable only) |
| WD-10 | ETSI library reads a `LoTELegalNotice` given as a multilingual string |
| WD-11 | Signed-metadata request asks for `application/jwt` only |
| WD-13 | Chain validated up to the first certificate that **is** a list anchor, not past it |
| WD-14 | Registration certificate `srv_description` read as TS 119 475 V1.2.1 defines it (array of arrays) |
| WD-15 | A leaf that is byte for byte a list anchor is trusted directly |
| WD-16 | Registration certificate status list may be a **CWT** |
| WD-17 | A CWT status list sent as base64url **text** is decoded (relaxation, for FNMT-RCM's endpoint) |
| WD-18 | Launchpad 2026 Testing Playbook schemes `eu-eaap://` and `eu-eaa-offer://` |
| WD-19 | Request Object fetched with `Accept: application/oauth-authz-req+jwt` (OpenID4VP 1.0 §5.10) |
| WD-20 | PID reused across presentations instead of used once (**privacy relaxation**: linkable) |

### Adding a deviation at the event

Follow the existing pattern exactly, because `build.sh` refuses a deviation flag it cannot honestly
honour:

1. Write the change against the clone (`upstream/`, `upstream-etsi/` or `upstream-walletcore/`), and
   save it as `deviations/wd-NN.patch`. A Wallet Core patch is applied on top of the earlier ones
   (wd-14 → wd-16 → wd-17), so generate it against that state.
2. In `build.sh`, add `WANT_WDNN`, its validation case, its dependency rule, and an apply block that
   **fails loudly** if its anchor text is gone. Library patches also need their unit tests and the
   `javap` marker check.
3. Add a row and a section to `deviations.md`. If upstream departs from a standard, also add an entry
   to `implementation/docs/interop-findings.md` (next free: **C18**, **D10**), citing the clause.
4. Run `--prepare-only` first, then the full build.

## 5. Phone: install and logs

On the Mac, `adb` is native and fast. On the Linux machine it went through usbipd and took
20 minutes per install, which is why the user usually installed APKs by hand.

```bash
adb devices
adb install -r out/<file>.apk               # -r keeps the data if the signing key is the same
adb logcat -c                                # clear BEFORE the user scans, so the log is one run
P=$(adb shell pidof eu.europa.ec.euidi.fnmtcediag)
adb logcat -d --pid=$P > run.log             # after the run
grep -E 'EDTP-DIAG|Trust result|not trusted|Invalid|Exception|RESPONSE: [45]' run.log
```

Useful tags: `EUDI Wallet DEMO-RELEASE` (Wallet Core and HTTP traffic in the diag build) and
`EDTP-DIAG` (the full cause chain of a failed issuance, plus DPoP and proof headers). If the
issuance or presentation screen lingers, the process stays the same; after a crash, take `pidof`
again. **`run.log` from the diagnostic build holds PID contents**: keep it out of the repository and
delete it after the event.

*Check Registration Certificates* is a wallet setting, **off by default**, and it gates both the
issuer and the verifier registration checks. Record which position each run used.

## 6. What failed, and why: a cookbook from F7 to F15

| What the log shows | Cause | Whose |
|---|---|---|
| `Issuer certificate chain is not trusted` / `Path does not chain with any of the trust anchors` on an **mDL**, with leaf `CN=FNMT Test PID Issuer, O=FNMT-RCM Test` | FNMT-RCM signs the mDL with its **PID** signer, which is only on the PID list. The mDL list holds `CN=FNMT-RCM TEST` under `AC FNMT QEAA-PSBEAA PROVIDER TEST`. Seen 27 October 2026, F15 diag; **FNMT-RCM is fixing it** | FNMT-RCM |
| `500 … Unsupported curve type: P-384` from `/inbox/inbox/request.jwt`, then `InvalidJarJwt` | FNMT-RCM's verifier could not sign its Request Object with a P-384 key. **Reported fixed** by the user, 27 October | FNMT-RCM |
| Issuance blocked after the registration certificate check | The app blocks unless the registration result is `Verified`. FNMT-RCM's RPRC still had `provided_attestations` instead of `provides_attestations` (TS 119 475 Table 7). Check any new RPRC for that, the mDL doctype `org.iso.18013.5.1.mDL`, and its signer | FNMT-RCM |
| Registration certificate status: JWT not found / timeout | FNMT-RCM's status list answers as a CWT only, as base64 text, after about 30 s. Handled by WD-16 and WD-17. Interop finding C17 | both |
| Chain fails although the anchor is on the list | WD-13 and WD-15 (finding C15, C16) | upstream library |

To list a trust list's certificates (subject, issuer, expiry), replacing `<list>` with
`pid`, `mdl`, `wrpac` or `wrprc`:

```bash
curl -s https://development.trust.tech.ec.europa.eu/lists/eudiw/<list>-providers.json -o l.json
python3 -I - l.json <<'EOF'
import sys,json,base64,subprocess,re
t=open(sys.argv[1]).read().strip()
try: j=json.loads(t)
except Exception:
    p=t.split('.')[1]; j=json.loads(base64.urlsafe_b64decode(p+'='*(-len(p)%4)))
for c in set(re.findall(r'"val": "([A-Za-z0-9+/=]{200,})"',json.dumps(j))):
    print(subprocess.run(['openssl','x509','-inform','DER','-noout','-subject','-issuer','-enddate'],
          input=base64.b64decode(c),capture_output=True).stdout.decode().replace('\n',' | '))
EOF
```

## 7. Rules that still hold at the event

- Modified build, always said so. A result from it is not a Reference Wallet result.
- Never commit an APK, a keystore, a password, a log with PID contents, or anything from the untracked
  `sources/` tree. `pnpm verify` and the pre-commit hook check confidentiality.
- A deliverable goes to FNMT-RCM only on its premises and in its own repository, together with
  `DELIVERY-NOTICE.md` filled in for that build. The diagnostic build is never handed over.
- WD-17 and WD-20 are relaxations, and `build.sh` prints a warning for each. Say so whenever a result
  depends on them.
- Everything committed is in English.

## 8. Open items at handoff

1. `wallet/fnmt-commission-lists` is pushed with this page. **Update PR #41**'s title and body to
   cover WD-12 to WD-20 and F7 to F15.
2. FNMT-RCM fixes: the mDL signer (§6, first row). In the RPRC: `provides_attestations`, the mDL
   doctype, and a signer that is an end-entity certificate under the CA. On the status list: binary,
   faster, and optionally a JWT.
3. Build and deliver the **deliverable** F15/F16 once FNMT-RCM's fixes are in, with its notice.
