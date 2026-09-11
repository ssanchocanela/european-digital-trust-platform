# EDTP test wallet — build tooling

A **modified** build of the official EUDI Reference Implementation Android wallet, for testing this
platform. **It is not the Reference Wallet.** No result from it may be reported as a Reference Wallet
result, and every report, log line, test name and PR statement that mentions it says "modified build"
— `CLAUDE.md` §8, without exception.

**No wallet source is in this repository.** `build.sh` clones upstream at a pinned tag into
`upstream/`, which is gitignored. What *is* committed here is the three patches, the build script, the
pins and the deviation register — enough to reproduce the APK, and nothing more.

Upstream is **EUPL-1.2** (`upstream/LICENSE.txt` after a clone). Every patch keeps the upstream file's
licence header, and the one new file carries it too.

## Quick start

```bash
# once — our own signing key, created outside the repository, password from a prompt
./make-signing-key.sh "$HOME/.edtp/wallet-signing/edtp-test-wallet.keystore"

export JAVA_HOME=/opt/homebrew/opt/openjdk@17     # a JDK 17, whatever its path is here
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_KEYSTORE_PATH="$HOME/.edtp/wallet-signing/edtp-test-wallet.keystore"
export ANDROID_KEY_ALIAS=edtp-test-wallet
export ANDROID_KEY_PASSWORD='…'                   # from your password manager, never a committed file

./build.sh
```

The APK lands in `out/` and the script prints a build record. **Keep that record** — it is what a test
result is a statement about.

`--prepare-only` stops after patching, for reviewing the patched tree. `--deviations` currently accepts
only `none`.

## What this build is, and is not

| | |
|---|---|
| `applicationId` | `eu.europa.ec.euidi.edtptest` — **installs alongside** the official `eu.europa.ec.euidi` |
| App name | `EDTP Test Wallet — modified reference build` |
| Banner | A red strip on **every** screen naming the build and its active deviations |
| Behaviour | **Upstream's.** No deviation is compiled in — see [`deviations.md`](deviations.md) |
| Signing | Our own key, certificate subject `OU=TEST ONLY` |

Verified against the built APK, not inferred: the `edtptest` flavour produces
`eu.europa.ec.euidi.edtptest` with that label, while the `demo` flavour from the same patched tree
still produces `eu.europa.ec.euidi` labelled `EUDI Wallet` with `EDTP_BUILD=false`. **Default is
upstream behaviour**, and that is a test of the patches, not a claim about them.

Two builds from the same inputs produced a **byte-identical APK** (SHA-256 `d4920abe…`), so the build
record identifies the artefact rather than merely describing it.

## Prerequisites

`build.sh` checks all of these and refuses with a specific message rather than letting Gradle fail
obscurely.

| | |
|---|---|
| JDK | **17** (upstream sets `sourceCompatibility = VERSION_17`) |
| Android SDK | platform **37**, build-tools **37.0.0** |
| Gradle | **9.7.1** — wrapper-pinned, downloaded by the wrapper. Do not use a local Gradle |
| Disk | ~6 GB for the clone, Gradle caches and build output |

The build takes about **7 minutes** cold on an M-series Mac and a few seconds when nothing changed.

### The APK is large, and that is upstream's doing

**363 MB.** Almost all of it is `libpodofo.so` (the PDF library behind remote signing) shipped for four
ABIs in one universal APK. An `arm64-v8a`-only build would be roughly a third of that, but restricting
ABIs is a change to what is packaged, so it is **not** done by default. If a device install is
awkward, that is the knob — and it belongs in the run record if used.

### If the Gradle wrapper download fails with a PKIX error

On a network that terminates TLS at a corporate proxy, the JDK does not trust the proxy's root even
though the OS does, and the wrapper download fails. `EDTP_JAVA_TRUSTSTORE` points the build at a
truststore that includes it:

```bash
cp "$JAVA_HOME/lib/security/cacerts" /tmp/edtp-cacerts
security find-certificate -a -c "<proxy CA name>" -p /Library/Keychains/System.keychain > /tmp/proxy.pem
keytool -importcert -noprompt -alias proxy-root -file /tmp/proxy.pem -keystore /tmp/edtp-cacerts -storepass changeit
export EDTP_JAVA_TRUSTSTORE=/tmp/edtp-cacerts
```

**This is a local environment workaround, not part of normal setup.** On a network without TLS
interception nothing above is needed, and no part of the build depends on it. It is written down only
so the PKIX error is not mistaken for a problem with the wallet or these patches.

## Layout

| | |
|---|---|
| `pins.env` | The pinned tag, commit and toolchain versions. **Changing a line here invalidates previously recorded test results** |
| `patches/` | Three unified diffs against the pinned tag, applied in order |
| `build.sh` | Clone → verify commit → reset → patch → generate source sets → stamp → build → record |
| `make-signing-key.sh` | Creates the keystore outside the repo, password from a prompt |
| `deviations.md` | The deviation register: WD-1, WD-2, WD-3 — what each is, where it goes, and why it is off |
| `INSTALL-AND-PID.md` | Step-by-step sheet for installing the build and obtaining a test PID |
| `upstream/` | Gitignored clone. Never committed |
| `out/` | Gitignored APKs. **Never committed and never published** |

### Why the flavour source sets are generated rather than committed

Three modules carry per-flavour sources, so a third flavour needs a third source set in each.
`build.sh` copies them from `demo`: with all deviations off their content is upstream's, so copying is
both the smallest change and the reason no upstream Kotlin is duplicated into this repository.

This is also why WD-1 and WD-2 will be cheap: `WalletCoreConfigImpl` is per-flavour, so they are
patches against *our* copy and **no upstream file is edited for them at all**.

## One thing to know before building another flavour from the prepared tree

`build.sh` writes `version.properties`, which upstream reads for `versionName`. So a `demo` build from
a tree this script has prepared is stamped `2026.09.42-edtptest` even though it is otherwise upstream's
demo build. Harmless for our purposes and worth knowing before reading a version string off such an
APK.
