#!/usr/bin/env bash
# Creates the platform-operated development **PID Provider CA**.
#
#   ./scripts/make-dev-pid-ca.sh
#
# It exists for the test PID issuer: a PID whose signing certificate chains to an anchor we control,
# so the end-to-end demonstration no longer depends on the EUDI reference issuer for its first step.
# The anchor reaches a verifier through a TEST list (`scripts/make-test-lote.mjs --kind pid`), loaded
# into the engine, and reaches the wallet through deviation **WD-4** (`pidProviders` pointing at that
# list) — a *modified* wallet, reported as one without exception (`CLAUDE.md` §8).
#
# ## What this is not
#
# It is not a PID Provider. ARF §3.18 and `EW-PIO-01-024` (`OIA_12`) take PID Provider anchors from
# a list notified by a Member State, and this CA is on none and never will be. A PID signed under it
# is **test data**, whatever it contains, and no result obtained with it says anything about a real
# PID. `trustEnvironment` `TEST` only; listed in `docs/security-limitations.md`.
#
# ## Why a separate CA from the Access CA
#
# Because the ARF keeps the trust domains apart — PID Providers, Access CAs, registration-certificate
# providers (`interop-findings.md` C1). The EUDI development environment collapses them into one set
# of seven anchors; this platform does not repeat that, so a PID anchor can never authenticate a
# Relying Party and an access anchor can never vouch for a PID.
#
# Only the CA is created here. The signing leaf is issued by `rotate-attestation-key.sh` with
# `SIGNING_CA_DIR` pointing at this directory, so a rotation never needs a new anchor — and every
# wallet build and loaded list carries the anchor, not the leaf.
#
# Written outside the repository, mode 600 under a mode-700 directory. `ca.key` is a secret.
set -euo pipefail

OUT_DIR="${EDTP_DEV_PID_CA_DIR:-$HOME/.edtp/dev-pid-ca}"

command -v openssl >/dev/null 2>&1 || { echo "openssl is required." >&2; exit 1; }

mkdir -p "$OUT_DIR"; chmod 700 "$OUT_DIR"
cd "$OUT_DIR"

if [ -f ca.crt ]; then
  echo "A development PID CA already exists in $OUT_DIR. Reusing it: a new anchor would invalidate"
  echo "every wallet build and every loaded list that carries the old one."
else
  echo "==> PID Provider CA (EC P-256, 2 years)"
  # `pathlen:0`: it signs PID signing certificates and no further CA.
  openssl ecparam -name prime256v1 -genkey -noout -out ca.key
  openssl req -new -x509 -key ca.key -out ca.crt -days 730 -sha256 \
    -subj "/CN=EDTP Development PID Provider CA - TEST ONLY/O=EDTP development, not a notified PID Provider/C=ES" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,digitalSignature,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash"
  chmod 600 ca.key ca.crt
fi

echo
printf 'CA SHA-256 fingerprint: '; openssl x509 -in ca.crt -noout -fingerprint -sha256 | sed 's/.*=//'
openssl x509 -in ca.crt -noout -subject -dates | sed 's/^/  /'

cat <<EOF

Next:
  1. The TEST PID list, carrying the notified anchors plus this one:
       node scripts/make-test-lote.mjs --kind pid --ca $OUT_DIR/ca.crt --url <published url> --out <path>
  2. A signing certificate under it, for the PID Attestation Provider:
       SIGNING_CA_DIR=$OUT_DIR PLATFORM_TENANT_API_KEY=… ./scripts/rotate-attestation-key.sh <providerId>
EOF
