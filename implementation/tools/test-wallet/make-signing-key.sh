#!/usr/bin/env bash
#
# Creates the signing keystore for the EDTP test wallet.
#
# Our own key, so nothing we build can be confused with an officially signed build, and so the APK
# can be installed alongside the official wallet. The keystore is a secret: it is created OUTSIDE
# the repository working tree, and the password is read from a prompt rather than an argument,
# because anything on a command line ends up in shell history and in process listings.
#
# Usage:  ./make-signing-key.sh /absolute/path/outside/the/repo/edtp-test-wallet.keystore

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
ALIAS="edtp-test-wallet"

TARGET="${1:-}"
[ -n "$TARGET" ] || { echo "usage: $0 /absolute/path/outside/the/repo/edtp-test-wallet.keystore" >&2; exit 2; }
case "$TARGET" in
  /*) ;;
  *) echo "give an absolute path, so there is no doubt where the keystore lands." >&2; exit 2 ;;
esac
case "$TARGET" in
  "$REPO_ROOT"/*) echo "refusing: that path is inside the repository working tree ($REPO_ROOT)." >&2; exit 2 ;;
esac
[ -e "$TARGET" ] && { echo "refusing: $TARGET already exists. Delete it deliberately first — a new" \
  "key means every APK signed with the old one can no longer be upgraded in place." >&2; exit 2; }

JAVA_BIN="${JAVA_HOME:+$JAVA_HOME/bin/keytool}"
[ -x "${JAVA_BIN:-}" ] || JAVA_BIN="$(command -v keytool || true)"
[ -n "${JAVA_BIN:-}" ] || { echo "keytool not found. Set JAVA_HOME to a JDK 17 installation." >&2; exit 1; }

printf 'Keystore password (not echoed, at least 12 characters): '
stty -echo; read -r PW1; stty echo; printf '\n'
printf 'Again: '
stty -echo; read -r PW2; stty echo; printf '\n'
[ "$PW1" = "$PW2" ] || { echo "passwords differ." >&2; exit 1; }
[ "${#PW1}" -ge 12 ] || { echo "too short: at least 12 characters." >&2; exit 1; }

mkdir -p "$(dirname "$TARGET")"
chmod 700 "$(dirname "$TARGET")" 2>/dev/null || true

# The subject says TEST ONLY in the certificate itself, so `apksigner verify --print-certs` on any
# APK we build states what it is without anyone having to look it up.
"$JAVA_BIN" -genkeypair \
  -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 -validity 730 \
  -keystore "$TARGET" \
  -storepass "$PW1" -keypass "$PW1" \
  -dname "CN=EDTP Test Wallet (modified reference build), OU=TEST ONLY, O=European Digital Trust Platform V0, C=EU"

chmod 600 "$TARGET"
unset PW1 PW2

cat <<EOF

Created $TARGET  (alias: $ALIAS)

Export these before running build.sh — from your password manager or an untracked shell file,
never from a committed file:

  export ANDROID_KEYSTORE_PATH="$TARGET"
  export ANDROID_KEY_ALIAS="$ALIAS"
  export ANDROID_KEY_PASSWORD='<the password you just entered>'

EOF
