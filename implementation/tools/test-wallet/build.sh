#!/usr/bin/env bash
#
# Reproducible build of the EDTP test wallet — a MODIFIED build of the official EUDI Reference
# Implementation Android wallet. It is not the Reference Wallet, and nothing it produces may be
# reported as a Reference Wallet result (CLAUDE.md §8).
#
# No wallet source lives in this repository. This script clones upstream at the pinned tag into
# ./upstream (gitignored), applies the patches in ./patches, generates the flavour source sets,
# and builds a signed APK into ./out (gitignored). The APK is never committed and never published.
#
# Usage:
#   ANDROID_KEYSTORE_PATH=... ANDROID_KEY_ALIAS=... ANDROID_KEY_PASSWORD=... ./build.sh
#   ... ./build.sh --deviations wd-3 --wrpac-lote https://<host>/lote/WRPACProviders.jwt
#
# Deviations: only `none` and `wd-3` are accepted. Each is refused unless everything it needs is
# present, because a flag that is accepted and does nothing puts a false claim in a test record.
#
#   --wrpac-lote <url>      required by wd-3. Where the wallet fetches WRPAC trust anchors.
#   --app-id-suffix <.sfx>  overrides the applicationId suffix, so a build can install ALONGSIDE
#                           an existing one instead of replacing it. Needed whenever the installed
#                           build must survive: uninstalling it deletes its documents, and a
#                           differently-signed APK cannot update it in place.
#   --app-name <name>       overrides the on-screen app name to match.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

# shellcheck source=pins.env
source ./pins.env

UPSTREAM_DIR="$HERE/upstream"
OUT_DIR="$HERE/out"
DEVIATIONS="none"
SKIP_BUILD="no"
WRPAC_LOTE=""
APP_ID_SUFFIX=""
APP_NAME=""

while [ $# -gt 0 ]; do
  case "$1" in
    --deviations) DEVIATIONS="${2:-}"; shift 2 ;;
    --wrpac-lote) WRPAC_LOTE="${2:-}"; shift 2 ;;
    --app-id-suffix) APP_ID_SUFFIX="${2:-}"; shift 2 ;;
    --app-name) APP_NAME="${2:-}"; shift 2 ;;
    --prepare-only) SKIP_BUILD="yes"; shift ;;
    -h|--help) sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "build.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

die() { echo "build.sh: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

# --- 0. Deviations -----------------------------------------------------------------------------
#
# Every deviation defaults to upstream behaviour, and none is implemented yet. Refusing an
# unimplemented flag outright is the point: a flag that is accepted and silently does nothing
# would put "WD-1 active" in a test record for a build where it was not.
case "$DEVIATIONS" in
  none) ;;
  wd-3)
    # Refused without the URL rather than defaulted to anything. A wd-3 build whose list location
    # were guessed would report the deviation as active while consulting the notified list, which
    # is the precise failure this gate exists to prevent.
    [ -n "$WRPAC_LOTE" ] ||
      die "--deviations wd-3 requires --wrpac-lote <url>: the list this build is to consult.
    Publish one with scripts/make-test-lote.mjs first. See deviations.md."
    case "$WRPAC_LOTE" in
      https://*) ;;
      *) die "--wrpac-lote must be https. A wallet will not fetch a trust list over cleartext." ;;
    esac
    [ -f "$HERE/deviations/wd-3.patch" ] || die "deviations/wd-3.patch is missing."
    ;;
  *)
    die "unknown or unimplemented deviation '$DEVIATIONS'.
    Accepted: none, wd-3. WD-1 and WD-2 are recorded in deviations.md and are not built — and a
    flag that is accepted and does nothing would put a false claim in a test record."
    ;;
esac

# --- 1. Prerequisites --------------------------------------------------------------------------
step "Checking prerequisites"

command -v git >/dev/null || die "git not found."

JAVA_BIN="${JAVA_HOME:+$JAVA_HOME/bin/java}"
[ -x "${JAVA_BIN:-}" ] || JAVA_BIN="$(command -v java || true)"
[ -n "${JAVA_BIN:-}" ] || die "no java found. Set JAVA_HOME to a JDK $WALLET_JDK_MAJOR installation."
# `.*"` would match to the LAST quote and capture nothing, so anchor on the first one. And pick the
# version line explicitly: a JVM with JAVA_TOOL_OPTIONS set prints a notice before it.
JAVA_VERSION="$("$JAVA_BIN" -version 2>&1 | grep 'version "' | sed -n 's/^[^"]*"\([0-9][0-9]*\).*/\1/p' | awk 'NR == 1')"
[ "$JAVA_VERSION" = "$WALLET_JDK_MAJOR" ] ||
  die "JDK $WALLET_JDK_MAJOR required (upstream sets sourceCompatibility 17); found $JAVA_VERSION at $JAVA_BIN."

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
[ -d "$SDK" ] || die "Android SDK not found at $SDK. Set ANDROID_HOME."
[ -d "$SDK/platforms/android-$WALLET_COMPILE_SDK.0" ] || [ -d "$SDK/platforms/android-$WALLET_COMPILE_SDK" ] ||
  die "Android platform $WALLET_COMPILE_SDK not installed in $SDK/platforms."
[ -d "$SDK/build-tools/$WALLET_BUILD_TOOLS" ] ||
  die "Android build-tools $WALLET_BUILD_TOOLS not installed in $SDK/build-tools."
export ANDROID_HOME="$SDK"

if [ "$SKIP_BUILD" = "no" ]; then
  : "${ANDROID_KEYSTORE_PATH:?set it to our own signing keystore (see make-signing-key.sh)}"
  : "${ANDROID_KEY_ALIAS:?set it to the key alias inside that keystore}"
  : "${ANDROID_KEY_PASSWORD:?set it to the key password — never pass a password on the command line}"
  [ -f "$ANDROID_KEYSTORE_PATH" ] || die "keystore not found at ANDROID_KEYSTORE_PATH."
  case "$ANDROID_KEYSTORE_PATH" in
    "$HERE"/*) die "the keystore must not live inside the repository working tree." ;;
  esac
fi

# Some networks terminate TLS at a corporate proxy whose root the JDK does not trust, which makes
# the Gradle wrapper download fail with a PKIX error. EDTP_JAVA_TRUSTSTORE is an escape hatch for
# that specific case. It is a local environment workaround, NOT part of normal setup — see the
# README. Nothing in the build depends on it.
if [ -n "${EDTP_JAVA_TRUSTSTORE:-}" ]; then
  [ -f "$EDTP_JAVA_TRUSTSTORE" ] || die "EDTP_JAVA_TRUSTSTORE is set but the file does not exist."
  export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:-} -Djavax.net.ssl.trustStore=$EDTP_JAVA_TRUSTSTORE -Djavax.net.ssl.trustStorePassword=${EDTP_JAVA_TRUSTSTORE_PASSWORD:-changeit}"
  echo "    using EDTP_JAVA_TRUSTSTORE (local TLS-proxy workaround)"
fi

echo "    java        $JAVA_VERSION ($JAVA_BIN)"
echo "    android sdk $SDK"

# --- 2. Upstream at the pinned tag -------------------------------------------------------------
step "Preparing upstream clone at $WALLET_UPSTREAM_TAG"

# EDTP_WALLET_MIRROR lets a second build reuse a local clone instead of fetching again. The commit
# assertion below is what makes the source trustworthy, not where it was fetched from.
ORIGIN="${EDTP_WALLET_MIRROR:-$WALLET_UPSTREAM_URL}"

if [ ! -d "$UPSTREAM_DIR/.git" ]; then
  echo "    cloning $ORIGIN"
  git clone --quiet --depth 1 --branch "$WALLET_UPSTREAM_TAG" "$ORIGIN" "$UPSTREAM_DIR"
fi

cd "$UPSTREAM_DIR"
ACTUAL="$(git rev-parse HEAD)"
if [ "$ACTUAL" != "$WALLET_UPSTREAM_COMMIT" ]; then
  die "upstream clone is at $ACTUAL, expected $WALLET_UPSTREAM_COMMIT.
    Delete ./upstream and run again, or correct pins.env if the pin is meant to move."
fi

# Reset to pristine upstream so the patches apply to a known state and a re-run is idempotent.
# `reset --hard` rather than `checkout -- .` so a staged change cannot survive either. Untracked
# build output is deliberately kept — that is what makes a rebuild incremental — so this is not a
# `git clean`; the two kinds of untracked file this script itself creates are removed below.
git reset --hard --quiet HEAD
rm -rf business-logic/src/"$EDTP_FLAVOR" core-logic/src/"$EDTP_FLAVOR" resources-logic/src/"$EDTP_FLAVOR"

# Files the patches ADD are untracked once applied, so `git apply` would refuse on a second run
# with "already exists in working directory". The list is derived from the patches rather than
# hard-coded here, so adding a patch needs no change to this script.
PATCH_ADDED_FILES="$(awk '/^--- \/dev\/null$/ { getline; if (sub(/^\+\+\+ b\//, "")) print }' \
  "$HERE"/patches/*.patch)"
if [ -n "$PATCH_ADDED_FILES" ]; then
  echo "$PATCH_ADDED_FILES" | while IFS= read -r added; do
    [ -n "$added" ] && rm -f "$added"
  done
fi

echo "    at $ACTUAL, working tree reset to upstream"

# --- 3. Patches --------------------------------------------------------------------------------
step "Applying patches"
for patch in "$HERE"/patches/*.patch; do
  git apply --whitespace=nowarn "$patch" || die "failed to apply $(basename "$patch"). The pinned
    tag and the patches must match; if the pin moved, the patches must be regenerated."
  echo "    applied $(basename "$patch")"
done

# --- 4. Generated flavour source sets ----------------------------------------------------------
#
# Three modules carry per-flavour sources, so a third flavour needs a third source set in each.
# They are COPIED from `demo` rather than written by hand and rather than committed here: with all
# deviations off the content is upstream's, so copying is both the smallest change and the reason
# no upstream Kotlin is duplicated into this repository. The deviations, when they are built, will
# be patches against these copies.
step "Generating $EDTP_FLAVOR source sets from demo"
for module in business-logic core-logic resources-logic; do
  cp -R "$module/src/demo" "$module/src/$EDTP_FLAVOR"
  echo "    $module/src/$EDTP_FLAVOR"
done

# --- 4b. Deviations, applied to the generated source sets --------------------------------------
#
# Separate from the patches in step 3 on purpose: those modify upstream files, while a deviation
# modifies OUR copy of a per-flavour source set, which does not exist until step 4. Keeping them
# apart is also what lets `--deviations none` produce a tree with no behavioural change at all.
if [ "$DEVIATIONS" = "wd-3" ]; then
  step "Applying WD-3 (wrpacProviders -> our TEST LoTE)"
  git apply --whitespace=nowarn "$HERE/deviations/wd-3.patch" ||
    die "failed to apply deviations/wd-3.patch. It is a diff against the demo source set; if
    upstream changed that file at the pinned tag, the deviation must be regenerated."

  # The URL is substituted rather than committed into the patch, so that the list location is a
  # build input recorded in the stamp below — not a constant buried in a diff.
  WD3_FILE="core-logic/src/$EDTP_FLAVOR/java/eu/europa/ec/corelogic/config/WalletCoreConfigImpl.kt"
  grep -q "__EDTP_WRPAC_LOTE__" "$WD3_FILE" || die "the WD-3 sentinel is missing from $WD3_FILE."
  # `|` as the delimiter: the replacement is a URL and contains slashes.
  sed -i.bak "s|__EDTP_WRPAC_LOTE__|$WRPAC_LOTE|" "$WD3_FILE" && rm -f "$WD3_FILE.bak"
  grep -q "$WRPAC_LOTE" "$WD3_FILE" || die "substituting the WD-3 list URL did not take effect."
  echo "    wrpacProviders -> $WRPAC_LOTE"
  echo "    this build consults a list we publish. Every result from it says 'modified wallet'."
fi

# --- 5. Build stamp ----------------------------------------------------------------------------
#
# version.properties is how upstream's build reads the version, and the patch reads the deviation
# list from the same file, so the banner in the app states exactly what this build contains.
step "Stamping the build"
# The identity overrides travel through version.properties, which the build already reads for the
# version and the deviation list — so a build can be given a distinct applicationId without a new
# flavour, new source sets or a patch edit per build.
EFFECTIVE_APP_ID_SUFFIX="${APP_ID_SUFFIX:-$EDTP_APPLICATION_ID_SUFFIX}"
EFFECTIVE_APP_NAME="${APP_NAME:-$EDTP_APP_NAME}"
cat > version.properties <<EOF
VERSION_NAME=$EDTP_VERSION_NAME
EDTP_DEVIATIONS=$DEVIATIONS
EDTP_APP_ID_SUFFIX=$EFFECTIVE_APP_ID_SUFFIX
EDTP_APP_NAME=$EFFECTIVE_APP_NAME
EDTP_WRPAC_LOTE=$WRPAC_LOTE
EOF
[ -f local.properties ] || echo "sdk.dir=$SDK" > local.properties
cat version.properties | sed 's/^/    /'

if [ "$SKIP_BUILD" = "yes" ]; then
  step "Prepared, not built (--prepare-only)"
  exit 0
fi

# --- 6. Build ----------------------------------------------------------------------------------
# Gradle capitalises the flavour in task names. Done with tr rather than bash's ${var^} because
# macOS still ships bash 3.2, where that expansion is a syntax error.
FLAVOR_TASK_NAME="$(printf '%s' "$EDTP_FLAVOR" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
TASK="assemble${FLAVOR_TASK_NAME}Release"
step "Building :app:$TASK"
# Upstream's gradle.properties asks for `-Xmx8192m`. On a machine with less physical memory than
# that the JVM is killed by the kernel partway through, which looks like a mysterious build failure
# — the log simply stops. So the heap is bounded here instead: passed on the command line, which
# overrides the project file without editing an upstream source file.
#
# Sized from what the machine actually has rather than fixed, and capped at upstream's request so
# this never *raises* it. The Kotlin compile daemon is bounded too, since it is a second JVM and
# the sum is what the kernel sees.
TOTAL_MB="$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo 2>/dev/null || echo 0)"
if [ -n "${EDTP_GRADLE_MAX_HEAP_MB:-}" ]; then
  HEAP_MB="$EDTP_GRADLE_MAX_HEAP_MB"
elif [ "$TOTAL_MB" -gt 0 ]; then
  HEAP_MB=$(( TOTAL_MB * 40 / 100 ))
  [ "$HEAP_MB" -gt 8192 ] && HEAP_MB=8192
  [ "$HEAP_MB" -lt 1536 ] && HEAP_MB=1536
else
  HEAP_MB=3072
fi
KOTLIN_HEAP_MB=$(( HEAP_MB / 2 ))
echo "    gradle heap ${HEAP_MB}m, kotlin daemon ${KOTLIN_HEAP_MB}m (machine has ${TOTAL_MB}m)"

# Android lint is disabled for release assembly, and this is a deliberate choice rather than a
# convenience. `lintVital` loads the model of every module at once and is what exhausts memory on a
# modest machine — it was the step that died here, twice, after compilation had already succeeded.
# It is also a code-quality gate on **upstream's** source, which this build does not modify
# meaningfully: the deviation is one line of configuration in our own flavour source set. Skipping
# it changes nothing about the artefact's behaviour, and leaving it on would mean the APK cannot be
# produced at all on this hardware.
#
# It is printed below so it reaches the build record, because it is a build input like any other.
echo "    android lint: skipped for release assembly (upstream quality gate; see build.sh)"

./gradlew --no-daemon \
  "-Dorg.gradle.jvmargs=-Xmx${HEAP_MB}m -Dfile.encoding=UTF-8" \
  "-Dkotlin.daemon.jvmargs=-Xmx${KOTLIN_HEAP_MB}m" \
  -Pandroid.lint.checkReleaseBuilds=false \
  ":app:$TASK"

# `awk NR==1` rather than `head -1` throughout this script: `head` closes the pipe early, which
# under `set -o pipefail` turns a perfectly successful command into a SIGPIPE failure (exit 141).
APK="$(find app/build/outputs/apk/"$EDTP_FLAVOR"/release -name '*.apk' | awk 'NR == 1')"
[ -n "$APK" ] || die "build reported success but no APK was produced."

mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$OUT_DIR/edtp-test-wallet-$EDTP_VERSION_NAME-$STAMP.apk"
cp "$APK" "$TARGET"

# --- 7. The run record -------------------------------------------------------------------------
#
# Printed in the shape a test record needs, because a record assembled from memory afterwards is
# the one that ends up wrong.
SHA="$(shasum -a 256 "$TARGET" | cut -d' ' -f1)"
SIGNER="$("$SDK/build-tools/$WALLET_BUILD_TOOLS/apksigner" verify --print-certs "$TARGET" 2>/dev/null |
  sed -n 's/^Signer #1 certificate SHA-256 digest: //p;s/^V2 Signer: certificate SHA-256 digest: //p' | awk 'NR == 1')"
BADGING="$("$SDK/build-tools/$WALLET_BUILD_TOOLS/aapt2" dump badging "$TARGET" 2>/dev/null | awk 'NR == 1')"

cat <<EOF

================================ build record ================================
 APK                  $TARGET
 APK SHA-256          $SHA
 signing cert SHA-256 ${SIGNER:-<unavailable>}
 $BADGING
 upstream tag         $WALLET_UPSTREAM_TAG
 upstream commit      $WALLET_UPSTREAM_COMMIT
 wallet core          $WALLET_CORE_VERSION
 active deviations    $DEVIATIONS
 patches applied      $(cd "$HERE/patches" && ls *.patch | tr '\n' ' ')
 platform commit      $(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo '<unknown>')
==============================================================================

 This is a MODIFIED build of the EUDI Reference Implementation. Do not report any result from it
 as a Reference Wallet result. Do not publish or distribute the APK.

EOF
