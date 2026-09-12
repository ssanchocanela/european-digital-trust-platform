#!/usr/bin/env bash
# Creates the platform-operated development Access CA and an access certificate signed by it.
#
#   ./scripts/make-dev-access-ca.sh [<san-dns-hostname>]
#
# This exists only because **Path A failed**. The reference RP Registration Service cannot issue an
# access certificate at all — `POST /intended_use/create` reports success and persists nothing, so
# the routes that would mint one are unreachable (`docs/interop-findings.md` C10). Path B is the
# fallback `CLAUDE.md` §8 reserves for exactly that, and this is its first half: a CA whose anchor
# goes into a *modified* wallet's reader trust store (WD-3), and a leaf the engine presents.
#
# ## What this is not
#
# It is not a substitute for enrolment, and nothing it produces may be described as trusted. A
# Wallet Unit accepts only Access CA anchors from the LoTEs notified by Member States —
# `AS-WP-06-005` (`RPA_04`) — and this CA is on none of them and never will be. A result obtained
# against a wallet carrying this anchor is a result from a **modified wallet**, the official result
# stays **unverified**, and every report must say so without exception (`CLAUDE.md` §8).
#
# `trustEnvironment` for anything configured with this is `TEST`. It must never appear in a
# `PRODUCTION` trust configuration, and it is listed in `docs/security-limitations.md`.
#
# ## Why two levels rather than one self-signed certificate
#
# Because the thing under test is chain validation. A self-signed leaf — what `smoke-vaas.sh`
# generates, and what the conformance suite rejected with "Leaf certificate in x5c chain must not be
# self-signed" — exercises no chain at all. A root that signs a leaf means the wallet does what it
# would do with a real certificate: build a path, and check it against an anchor. Only the anchor's
# provenance is fake, which is the smallest possible lie.
#
# Two levels, not three. A real hierarchy would have a root and an issuing CA; adding one here would
# test our own plumbing rather than the wallet's, and ETSI profile strictness is relaxed in the
# reference build anyway (`interop-findings.md` C3).
#
# Everything is written outside the repository, mode 600 under a mode-700 directory. The private
# keys are secrets; `*.p12`, `*.key` and `*.pem` are gitignored as a second line of defence, but the
# first is that these files are never in the tree.
set -euo pipefail

SAN_DNS="${1:-localhost}"
OUT_DIR="${EDTP_DEV_CA_DIR:-$HOME/.edtp/dev-access-ca}"

command -v openssl >/dev/null 2>&1 || { echo "openssl is required." >&2; exit 1; }

mkdir -p "$OUT_DIR"; chmod 700 "$OUT_DIR"
cd "$OUT_DIR"

if [ -f ca.crt ]; then
  echo "A development CA already exists in $OUT_DIR."
  echo "Reusing it: re-creating the CA would invalidate every wallet build that carries the old"
  echo "anchor, and a test run's record names the anchor it trusted."
  echo
else
  echo "==> Access CA (EC P-256, 2 years)"
  openssl ecparam -name prime256v1 -genkey -noout -out ca.key
  # `keyCertSign` and `cRLSign` are what make this usable as a CA at all; `pathlen:0` says it may
  # sign end-entity certificates and no further CA, which is true and keeps the profile honest.
  openssl req -new -x509 -key ca.key -out ca.crt -days 730 -sha256 \
    -subj "/CN=EDTP Development Access CA - TEST ONLY/O=EDTP development, not a notified CA/C=ES" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,digitalSignature,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash"
  chmod 600 ca.key ca.crt
fi

echo "==> Access certificate (leaf, EC P-256, 90 days, SAN DNS:$SAN_DNS)"
# Regenerated on every run, deliberately. The leaf carries the public hostname as a SAN, and that
# hostname changes with every quick tunnel — so a leaf is cheap and short-lived while the anchor,
# which a wallet build is compiled against, is stable.
openssl ecparam -name prime256v1 -genkey -noout -out access.key
openssl req -new -key access.key -out access.csr -sha256 \
  -subj "/CN=EDTP EUDI Gate - TEST/O=EDTP Test Entity SL/C=ES"

cat > leaf.ext <<EXT
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = clientAuth
subjectAltName = DNS:$SAN_DNS
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
EXT

openssl x509 -req -in access.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out access.crt -days 90 -sha256 -extfile leaf.ext
rm -f access.csr leaf.ext

# PKCS#8 for the engine's key-chain import, which takes a JWK derived from it — see
# scripts/import-access-certificate.sh and interop-findings.md A8.
openssl pkcs8 -topk8 -nocrypt -in access.key -out access.key8.pem

# A PKCS#12 as well, so `verify-access-certificate-chain.sh` can be pointed at this the same way it
# would be pointed at a real one. It will report that the leaf does not chain to a notified anchor,
# which is correct and is the whole reason WD-3 exists. Run it anyway and record the result.
PASS_SOURCE="env:EDTP_DEV_CA_P12_PASSWORD"
if [ -z "${EDTP_DEV_CA_P12_PASSWORD:-}" ]; then
  read -r -s -p "Passphrase for the PKCS#12 bundle: " EDTP_DEV_CA_P12_PASSWORD; echo
  export EDTP_DEV_CA_P12_PASSWORD
fi
openssl pkcs12 -export -out access.p12 -inkey access.key -in access.crt -certfile ca.crt \
  -name "EDTP dev access certificate (TEST)" -passout "$PASS_SOURCE"
unset EDTP_DEV_CA_P12_PASSWORD

chmod 600 ./*.key ./*.crt ./*.pem ./*.p12 2>/dev/null || true

echo
echo "==> Fingerprints, for the run record"
printf '    CA   '; openssl x509 -in ca.crt -noout -fingerprint -sha256 | sed 's/.*=//'
printf '    leaf '; openssl x509 -in access.crt -noout -fingerprint -sha256 | sed 's/.*=//'
openssl x509 -in access.crt -noout -subject -issuer -dates | sed 's/^/    /'

cat <<EOF

Written to $OUT_DIR (mode 700):

  ca.crt           the anchor. Goes into the wallet build as a raw resource — WD-3.
  ca.key           the CA private key. A secret. Needed only to issue another leaf.
  access.crt       the leaf the engine presents.
  access.key8.pem  its private key, PKCS#8, for the engine's key-chain import.
  access.p12       both, bundled, for verify-access-certificate-chain.sh.

Next:

  1. Record the CA fingerprint above in docs/reference-wallet-testing.md. A test run's record must
     name the anchor the wallet trusted, or the result cannot be interpreted later.

  2. Build the wallet with this anchor:
       tools/test-wallet/build.sh --deviations wd-3 --access-ca $OUT_DIR/ca.crt

  3. Import the leaf into the engine:
       TENANT_ID=... PLATFORM_TENANT_API_KEY=... \\
         ./scripts/import-access-certificate.sh <service-id> <engine-tenant-ref> $OUT_DIR/access.p12

  4. Re-issue the leaf with the real SAN once a tunnel hostname exists:
       ./scripts/make-dev-access-ca.sh <hostname>
     The CA is reused, so the wallet build stays valid.

This is TEST trust material. It is not an enrolment, nothing here is trusted by any wallet that has
not been modified to trust it, and a result obtained with it is a result from a modified wallet.
EOF
