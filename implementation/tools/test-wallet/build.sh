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
# Deviations: `none`, `wd-2`, `wd-3`, `wd-4`, or a comma-separated set (`wd-2,wd-3`). Each is refused unless
# everything it needs is present, because a flag that is accepted and does nothing puts a false claim
# in a test record. `wd-1` is refused outright: it needs a published list of **issuer** anchors,
# which does not exist.
#
# `wd-2,wd-3` is the combination that reaches the §7.3 eligibility presentation — wd-2 to get past
# the issuer gate the engine cannot satisfy, wd-3 so the request object's access certificate is
# trusted. **wd-2 is a security relaxation and bypasses gate (a) rather than meeting it.**
#
#   --wrpac-lote <url>      required by wd-3. Where the wallet fetches WRPAC trust anchors.
#   --pid-lote <url>        required by wd-4. Where the wallet fetches PID Provider trust anchors.
#   --issuer <url>[,<url>]  required by wd-5. The ONLY issuers "Add document > From list" offers:
#                           one, or two in list order (upstream has two slots, and WD-5 reuses them).
#   --pid-label <text>      optional with wd-5. Replaces upstream's "PID Combined" row label.
#
# `wd-2,wd-3,wd-4` is the build for the test PID issuer: wd-4 so a PID signed under our development
# PID Provider CA is trusted, the other two for the reasons above.
#   --app-id-suffix <.sfx>  overrides the applicationId suffix, so a build can install ALONGSIDE
#                           an existing one instead of replacing it. Needed whenever the installed
#                           build must survive: uninstalling it deletes its documents, and a
#                           differently-signed APK cannot update it in place.
#   --app-name <name>       overrides the on-screen app name to match.
#   --build-type <type>     `release` (default) or `debug`.
#
# `debug` exists for diagnosis, not for results. Upstream's NetworkModule sets Ktor's HTTP logging
# to LogLevel.BODY for DEBUG and NONE for RELEASE, so a release build writes no application logging
# whatever — which is how a blocked presentation gave no reason on 13 September 2026. A debug build
# also carries `debuggable`, so `adb shell run-as` can read the app's data directory and show
# whether a trust list was fetched and cached at all. It is signed with the SDK's debug key, so a
# result from it is even further from an official one than the release build already is.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

# shellcheck source=pins.env
source ./pins.env

UPSTREAM_DIR="$HERE/upstream"
OUT_DIR="$HERE/out"
DEVIATIONS="none"
# Diagnostic logging, opt-in and stamped. NOT a deviation: it changes no behaviour and
# invalidates no result. It exists because two places in the upstream reduce a throwable to
# `localizedMessage` and discard it, so a Kotlin exception raised without a message reaches
# the screen as "Oups! Something went wrong" and reaches the log as nothing at all.
DIAGNOSTICS=no
SKIP_BUILD="no"
WRPAC_LOTE=""
PID_LOTE=""
ISSUER_URL=""
PID_LABEL=""
APP_ID_SUFFIX=""
APP_NAME=""
BUILD_TYPE="release"

while [ $# -gt 0 ]; do
  case "$1" in
    --deviations) DEVIATIONS="${2:-}"; shift 2 ;;
    --diagnostics) DIAGNOSTICS=yes; shift 1 ;;
    --wrpac-lote) WRPAC_LOTE="${2:-}"; shift 2 ;;
    --pid-lote) PID_LOTE="${2:-}"; shift 2 ;;
    --issuer) ISSUER_URL="${2:-}"; shift 2 ;;
    --pid-label) PID_LABEL="${2:-}"; shift 2 ;;
    --app-id-suffix) APP_ID_SUFFIX="${2:-}"; shift 2 ;;
    --app-name) APP_NAME="${2:-}"; shift 2 ;;
    --build-type) BUILD_TYPE="${2:-}"; shift 2 ;;
    --prepare-only) SKIP_BUILD="yes"; shift ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
# `--deviations` takes a comma-separated set, because a useful build needs more than one: reaching
# the §7.3 eligibility presentation needs wd-2 to pass the issuer gate *and* wd-3 so the request
# object's access certificate is trusted. Each is still validated on its own terms, and an unknown
# or unbuildable name is refused rather than ignored.
WANT_WD2=no
WANT_WD3=no
WANT_WD4=no
WANT_WD5=no
if [ "$DEVIATIONS" != "none" ]; then
  OLD_IFS="$IFS"; IFS=,
  for d in $DEVIATIONS; do
    case "$d" in
      wd-2)
        [ -f "$HERE/deviations/wd-2.patch" ] || die "deviations/wd-2.patch is missing."
        WANT_WD2=yes
        ;;
      wd-3)
        # Refused without the URL rather than defaulted to anything. A wd-3 build whose list
        # location were guessed would report the deviation as active while consulting the notified
        # list, which is the precise failure this gate exists to prevent.
        [ -n "$WRPAC_LOTE" ] ||
          die "--deviations wd-3 requires --wrpac-lote <url>: the list this build is to consult.
    Publish one with scripts/make-test-lote.mjs first. See deviations.md."
        case "$WRPAC_LOTE" in
          https://*) ;;
          *) die "--wrpac-lote must be https. A wallet will not fetch a trust list over cleartext." ;;
        esac
        [ -f "$HERE/deviations/wd-3.patch" ] || die "deviations/wd-3.patch is missing."
        WANT_WD3=yes
        ;;
      wd-4)
        # Refused without the URL, for the same reason as wd-3.
        [ -n "$PID_LOTE" ] ||
          die "--deviations wd-4 requires --pid-lote <url>: the PID Provider list this build is to
    consult. Publish one with scripts/make-test-lote.mjs --kind pid first. See deviations.md."
        case "$PID_LOTE" in
          https://*) ;;
          *) die "--pid-lote must be https. A wallet will not fetch a trust list over cleartext." ;;
        esac
        [ -f "$HERE/deviations/wd-4.kt" ] || die "deviations/wd-4.kt is missing."
        WANT_WD4=yes
        ;;
      wd-5)
        # Refused without the URL: a wd-5 build that still listed the EUDI issuers would report the
        # deviation while offering them, and one listing a guessed URL would offer nothing that works.
        [ -n "$ISSUER_URL" ] ||
          die "--deviations wd-5 requires --issuer <url>: the Credential Issuer the wallet's list is to
    offer, as its metadata names it (e.g. https://edtp-engine.murcata.es/issuers/pid-1)."
        for u in $(printf '%s' "$ISSUER_URL" | tr ',' ' '); do
          case "$u" in
            https://*) ;;
            *) die "--issuer must be https. The wallet will not fetch issuer metadata over cleartext." ;;
          esac
        done
        [ "$(printf '%s' "$ISSUER_URL" | tr ',' '\n' | grep -c .)" -le 2 ] ||
          die "--issuer takes at most two URLs: WD-5 reuses upstream's two issuer slots and adds none."
        WANT_WD5=yes
        ;;
      wd-1)
        die "wd-1 is recorded in deviations.md and is not built. It needs an ETSI TS 119 602 list
    of **issuer** anchors published and reachable, which does not exist — scripts/make-test-lote.mjs
    produces the WRPAC list only. A flag that is accepted and does nothing would put a false claim
    in a test record."
        ;;
      *)
        die "unknown deviation '$d'. Accepted: none, wd-2, wd-3, wd-4, wd-5, or a comma-separated set of them."
        ;;
    esac
  done
  IFS="$OLD_IFS"
fi

if [ "$WANT_WD2" = "yes" ]; then
  cat >&2 <<'WARN'

  WD-2 is a SECURITY RELAXATION, not a configuration of an intended mechanism. It accepts unsigned
  issuer metadata, and it additionally switches off the issuer registration-certificate check —
  `IssuerCreator` applies that check only under RequireSigned, whatever the Wallet's own
  *Check Registration Certificates* preference says.

  So no result from this build may state that ARF §6.6.2.2 gate (a) is satisfied, and none can
  evidence AS-AP-44-005 (RPRC_22a) or AS-AP-44-007 (RPRC_23). The gate is bypassed, not met.

WARN
fi

case "$BUILD_TYPE" in
  release|debug) ;;
  *) die "unknown --build-type '$BUILD_TYPE'. Accepted: release, debug." ;;
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

if [ "$SKIP_BUILD" = "no" ] && [ "$BUILD_TYPE" = "release" ]; then
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

# Diagnostic logging, opt-in. Applied here because it touches `src/main` in two modules, not a
# flavour source set — it instruments upstream code that every flavour shares.
#
# It is deliberately NOT a deviation. A deviation changes what the wallet accepts and so changes
# what a result means; this only prints what upstream already computed and then discarded. It is
# still stamped into version.properties, because a build that was instrumented and a build that was
# not are different builds, and a run record should not have to take anyone's word for which it was.
if [ "$DIAGNOSTICS" = "yes" ]; then
  [ -f "$HERE/diagnostics/diag-issuance.patch" ] || die "diagnostics/diag-issuance.patch is missing."
  git apply --whitespace=nowarn "$HERE/diagnostics/diag-issuance.patch" ||
    die "failed to apply diagnostics/diag-issuance.patch against the pinned tag."
  echo "    applied diagnostics/diag-issuance.patch (logging only, tag EDTP-DIAG)"
fi

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
if [ "$WANT_WD2" = "yes" ]; then
  step "Applying WD-2 (requireSignedMetadata -> preferSignedMetadata)"
  git apply --whitespace=nowarn "$HERE/deviations/wd-2.patch" ||
    die "failed to apply deviations/wd-2.patch. It is a diff against the demo source set; if
    upstream changed that file at the pinned tag, the deviation must be regenerated."
  WD2_FILE="core-logic/src/$EDTP_FLAVOR/java/eu/europa/ec/corelogic/config/WalletCoreConfigImpl.kt"
  grep -q "preferSignedMetadata()" "$WD2_FILE" ||
    die "WD-2 did not take effect: preferSignedMetadata() is not in $WD2_FILE."
  grep -q "^ *requireSignedMetadata()" "$WD2_FILE" &&
    die "WD-2 left requireSignedMetadata() in place, so the relaxation would be a no-op."
  echo "    issuer metadata: unsigned accepted. Gate (a) BYPASSED, not met."
fi

if [ "$WANT_WD3" = "yes" ]; then
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

if [ "$WANT_WD4" = "yes" ]; then
  step "Applying WD-4 (pidProviders -> our TEST PID LoTE)"
  # A line replacement rather than a patch: wd-3.patch carries the upstream `pidProviders` line as
  # context, so a second patch changing it could never be applied together with wd-3. Anchored on
  # the exact upstream line, and refused if that line is not there exactly once.
  WD4_FILE="core-logic/src/$EDTP_FLAVOR/java/eu/europa/ec/corelogic/config/WalletCoreConfigImpl.kt"
  WD4_LINE='pidProviders = Uri("https://trustedlist.serviceproviders.eudiw.dev/LOTE/json/PIDProviders.jwt"),'
  [ "$(grep -cF "$WD4_LINE" "$WD4_FILE")" = "1" ] ||
    die "the upstream pidProviders line is not in $WD4_FILE exactly once; WD-4 must be regenerated."
  awk -v line="$WD4_LINE" -v fragment="$HERE/deviations/wd-4.kt" '
    index($0, line) { while ((getline l < fragment) > 0) print l; next } { print }
  ' "$WD4_FILE" > "$WD4_FILE.new" && mv "$WD4_FILE.new" "$WD4_FILE"
  grep -qF "$WD4_LINE" "$WD4_FILE" && die "WD-4 left the notified pidProviders list in place."
  sed -i.bak "s|__EDTP_PID_LOTE__|$PID_LOTE|" "$WD4_FILE" && rm -f "$WD4_FILE.bak"
  grep -q "pidProviders = Uri(\"$PID_LOTE\")" "$WD4_FILE" ||
    die "substituting the WD-4 list URL did not take effect."
  echo "    pidProviders -> $PID_LOTE"
  echo "    this build trusts PIDs signed under our development CA. Every result says 'modified wallet'."
fi

if [ "$WANT_WD5" = "yes" ]; then
  step "Applying WD-5 (the wallet's issuer list -> our issuers only)"
  # "Add document > From list" is built from the Credential Issuer metadata of the issuers in
  # `issuersConfig`, not from any remote list. Upstream carries two, the EUDI reference issuer and its
  # backend; this build carries ours — one or two — in those same slots, with every other setting kept
  # as upstream has it. Anchored on the two exact upstream URLs, and refused if either is not there
  # exactly once.
  WD5_FILE="core-logic/src/$EDTP_FLAVOR/java/eu/europa/ec/corelogic/config/WalletCoreConfigImpl.kt"
  WD5_FIRST='issuerUrl = "https://issuer.eudiw.dev",'
  WD5_SECOND='issuerUrl = "https://issuer-backend.eudiw.dev",'
  [ "$(grep -cF "$WD5_FIRST" "$WD5_FILE")" = "1" ] && [ "$(grep -cF "$WD5_SECOND" "$WD5_FILE")" = "1" ] ||
    die "the upstream issuer URLs are not in $WD5_FILE exactly once each; WD-5 must be regenerated."
  WD5_URL1="${ISSUER_URL%%,*}"
  WD5_URL2=""
  case "$ISSUER_URL" in *,*) WD5_URL2="${ISSUER_URL#*,}" ;; esac
  WD5_COUNT=1
  if [ -n "$WD5_URL2" ]; then
    # Two issuers: the second slot, pointed at the second URL. Same settings as the first.
    sed -i.bak "s|$WD5_SECOND|issuerUrl = \"$WD5_URL2\",|" "$WD5_FILE" && rm -f "$WD5_FILE.bak"
    WD5_COUNT=2
  else
  # One issuer: drop the second VciConfig block whole (from its `VciConfig(` to its closing `)`).
  awk -v marker="$WD5_SECOND" '
    /^ *VciConfig\($/ { buf = $0 "\n"; inblock = 1; next }
    inblock { buf = buf $0 "\n"; if ($0 ~ /^ {12}\),?$/) { inblock = 0; if (index(buf, marker) == 0) printf "%s", buf; buf = "" } ; next }
    { print }
  ' "$WD5_FILE" > "$WD5_FILE.new" && mv "$WD5_FILE.new" "$WD5_FILE"
  fi
  sed -i.bak "s|$WD5_FIRST|issuerUrl = \"$WD5_URL1\",|" "$WD5_FILE" && rm -f "$WD5_FILE.bak"
  grep -qF "eudiw.dev\"," "$WD5_FILE" && grep -qE 'issuerUrl = "https://issuer(-backend)?\.eudiw\.dev"' "$WD5_FILE" &&
    die "WD-5 left an EUDI issuer in the list."
  [ "$(grep -c 'issuerUrl = ' "$WD5_FILE")" = "$WD5_COUNT" ] ||
    die "WD-5 did not leave exactly $WD5_COUNT issuer(s)."
  grep -qF "issuerUrl = \"$WD5_URL1\"," "$WD5_FILE" || die "substituting the WD-5 issuer did not take effect."
  [ -z "$WD5_URL2" ] || grep -qF "issuerUrl = \"$WD5_URL2\"," "$WD5_FILE" ||
    die "substituting the second WD-5 issuer did not take effect."
  if [ -n "$PID_LABEL" ]; then
    # Upstream labels an issuer's merged PID row with a fixed "PID Combined". A flavour resource
    # overrides that one string and nothing else; the XML-special characters are escaped.
    LABEL_XML="$(printf '%s' "$PID_LABEL" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')"
    mkdir -p "resources-logic/src/$EDTP_FLAVOR/res/values"
    cat > "resources-logic/src/$EDTP_FLAVOR/res/values/edtp_wd5_strings.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by tools/test-wallet/build.sh for deviation WD-5. Not upstream. -->
<resources>
    <string name="issuance_add_document_pid_combined">$LABEL_XML</string>
</resources>
XML
    echo "    PID row label -> $PID_LABEL"
  fi
  echo "    issuersConfig -> $ISSUER_URL (only)"
  echo "    this build offers our issuers and nothing else. Every result says 'modified wallet'."
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
EDTP_DIAGNOSTICS=$DIAGNOSTICS
EDTP_APP_ID_SUFFIX=$EFFECTIVE_APP_ID_SUFFIX
EDTP_APP_NAME=$EFFECTIVE_APP_NAME
EDTP_WRPAC_LOTE=$WRPAC_LOTE
EDTP_PID_LOTE=$PID_LOTE
EDTP_ISSUER_URL=$ISSUER_URL
EDTP_PID_LABEL=$PID_LABEL
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
BUILD_TYPE_TASK_NAME="$(printf '%s' "$BUILD_TYPE" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
TASK="assemble${FLAVOR_TASK_NAME}${BUILD_TYPE_TASK_NAME}"
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
APK="$(find app/build/outputs/apk/"$EDTP_FLAVOR"/"$BUILD_TYPE" -name '*.apk' | awk 'NR == 1')"
[ -n "$APK" ] || die "build reported success but no APK was produced."

mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$OUT_DIR/edtp-test-wallet-$EDTP_VERSION_NAME-$BUILD_TYPE-$STAMP.apk"
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
 build type           $BUILD_TYPE
 active deviations    $DEVIATIONS
 patches applied      $(cd "$HERE/patches" && ls *.patch | tr '\n' ' ')
 platform commit      $(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo '<unknown>')
==============================================================================

 This is a MODIFIED build of the EUDI Reference Implementation. Do not report any result from it
 as a Reference Wallet result. Do not publish or distribute the APK.

EOF
