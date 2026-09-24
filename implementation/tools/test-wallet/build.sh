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
#
# Deviations: none are implemented yet. --deviations accepts only "none" in W1; see deviations.md.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

# shellcheck source=pins.env
source ./pins.env

UPSTREAM_DIR="$HERE/upstream"
OUT_DIR="$HERE/out"
DEVIATIONS="none"
SKIP_BUILD="no"

while [ $# -gt 0 ]; do
  case "$1" in
    --deviations) DEVIATIONS="${2:-}"; shift 2 ;;
    --prepare-only) SKIP_BUILD="yes"; shift ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
if [ "$DEVIATIONS" != "none" ]; then
  die "deviations are not implemented in this build (asked for '$DEVIATIONS').
    WD-1, WD-2 and WD-3 are recorded in deviations.md and are W2 work. This script builds the
    renamed identity only, so it cannot honestly claim any deviation is active."
fi

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

# --- 5. Build stamp ----------------------------------------------------------------------------
#
# version.properties is how upstream's build reads the version, and the patch reads the deviation
# list from the same file, so the banner in the app states exactly what this build contains.
step "Stamping the build"
cat > version.properties <<EOF
VERSION_NAME=$EDTP_VERSION_NAME
EDTP_DEVIATIONS=$DEVIATIONS
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
./gradlew --no-daemon ":app:$TASK"

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
