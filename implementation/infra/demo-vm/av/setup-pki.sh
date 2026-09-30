#!/usr/bin/env bash
# Prepares the age verification demos on the demonstration VM (ADR 0011). Run once, on the VM, as the
# operator; safe to re-run, and it never overwrites what it made unless told to (--rotate).
#
#   infra/demo-vm/av/setup-pki.sh <trusted-issuers.p12 copied from the issuer's machine>
#
# age_verification_platform is a private repository, so nothing here clones it. Its PKI generator and
# the public certificates it pins are copied to the VM first, from a checkout of it:
#
#   scp -r <checkout>/pki/generate-test-pki.sh <checkout>/pki/trust edtp-demo:.av/pki-tools/
#
# 1. A TEST PKI for av-verifier.murcata.es, generated here with age_verification_platform's own
#    pki/generate-test-pki.sh, in ~/.av/pki, keeping only what the verifier reads. The request-signing certificate's SAN must be that hostname
#    (the client id is x509_san_dns). The wallet does not enforce reader trust, so a TEST reader CA works.
# 2. trusted-issuers.p12 REPLACED by the one given: the Document Signer certificates of the issuer that
#    issued the attestations in the wallets that will be shown. It holds certificates only, no private key.
#    A trust store generated here would trust a signer nobody issued with.
# 3. ~/.av/demos.env: the demos' API keys, their digests, the session secrets and the PKI password, all
#    random, mode 600.
set -euo pipefail

ISSUERS="${1:?usage: setup-pki.sh <trusted-issuers.p12> [--rotate]}"
ROTATE="${2:-}"
AV_DIR="$HOME/.av"
TOOLS="$AV_DIR/pki-tools"
PKI="$AV_DIR/pki"
ENV_FILE="$AV_DIR/demos.env"

[ -f "$ISSUERS" ] || { echo "no such file: $ISSUERS" >&2; exit 1; }
install -d -m 700 "$AV_DIR"

[ -x "$TOOLS/generate-test-pki.sh" ] && [ -d "$TOOLS/trust" ] || {
  echo "copy age_verification_platform's pki/generate-test-pki.sh and pki/trust to $TOOLS first" >&2
  exit 1
}

random() { openssl rand -base64 36 | tr -d '/+=' | cut -c1-40; }

if [ ! -f "$ENV_FILE" ] || [ "$ROTATE" = --rotate ]; then
  lumen_key="$(random)" plaza_key="$(random)"
  umask 077
  cat > "$ENV_FILE" <<ENV
AV_IMAGE_TAG=$(sed -n 's/^AV_IMAGE_TAG=//p' "$ENV_FILE" 2>/dev/null || true)
AV_PKI_PASSWORD=$(random)
LUMEN_VERIFIER_API_KEY=$lumen_key
PLAZA_VERIFIER_API_KEY=$plaza_key
AV_LUMEN_DEMO_API_KEY_SHA256=$(printf '%s' "$lumen_key" | sha256sum | cut -d' ' -f1)
AV_PLAZA_DEMO_API_KEY_SHA256=$(printf '%s' "$plaza_key" | sha256sum | cut -d' ' -f1)
LUMEN_SESSION_SECRET=$(random)
PLAZA_SESSION_SECRET=$(random)
ENV
  echo "wrote $ENV_FILE"
fi
password="$(sed -n 's/^AV_PKI_PASSWORD=//p' "$ENV_FILE")"
command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }

read -r -s -p "Password of $ISSUERS (the issuer machine's PKI password): " source_password; echo

# The VM has no Java, and the generator needs keytool: the PKI work runs in a throwaway JDK container,
# as root inside it, and hands the files back to the operator.
generate=0
{ [ ! -f "$PKI/verifier.p12" ] || [ "$ROTATE" = --rotate ]; } && generate=1
docker run --rm -i \
  -e GENERATE="$generate" -e PASSWORD="$password" -e SOURCE_PASSWORD="$source_password" \
  -e OWNER="$(id -u):$(id -g)" \
  -v "$TOOLS:/repo/pki:ro" -v "$AV_DIR:/av" -v "$(realpath "$ISSUERS"):/in/trusted-issuers.p12:ro" \
  eclipse-temurin:21-jdk bash -euo pipefail -s <<'IN_CONTAINER'
command -v openssl >/dev/null || { apt-get update -qq && apt-get install -y -qq openssl >/dev/null; }
if [ "$GENERATE" = 1 ]; then
  rm -rf /av/pki
  PKI_KEYSTORE_PASSWORD="$PASSWORD" /repo/pki/generate-test-pki.sh /av/pki av-verifier.murcata.es >/dev/null
  # The generator makes a whole TEST PKI, issuer and wallet provider included. The verifier uses four of
  # its files; the rest are signing keys nothing here needs, and are not left lying on the VM.
  find /av/pki -type f ! -name verifier.p12 ! -name result-signing.key ! -name tl-signers.p12 -delete
  echo "generated the TEST PKI for av-verifier.murcata.es (verifier.p12, result-signing.key, tl-signers.p12)"
fi
# The given store, re-encrypted with this PKI's password so the verifier opens all its stores alike.
rm -f /av/pki/trusted-issuers.p12.new
keytool -importkeystore -noprompt \
  -srckeystore /in/trusted-issuers.p12 -srcstoretype PKCS12 -srcstorepass "$SOURCE_PASSWORD" \
  -destkeystore /av/pki/trusted-issuers.p12.new -deststoretype PKCS12 -deststorepass "$PASSWORD" >/dev/null
if keytool -list -keystore /av/pki/trusted-issuers.p12.new -storepass "$PASSWORD" | grep -q PrivateKeyEntry; then
  rm -f /av/pki/trusted-issuers.p12.new
  echo "refused: the store given contains a private key; a trust store must hold certificates only" >&2
  exit 1
fi
mv /av/pki/trusted-issuers.p12.new /av/pki/trusted-issuers.p12
echo "trusted issuers:"
keytool -list -v -keystore /av/pki/trusted-issuers.p12 -storepass "$PASSWORD" | grep -E '^(Alias name|Owner):'
chown -R "$OWNER" /av/pki
IN_CONTAINER

# Read inside the verifier's container by an unprivileged user. The directory above is 700, so no other
# user on the VM can reach these.
chmod 755 "$PKI"
find "$PKI" -type f -exec chmod 644 {} +
echo "done. Deploy with: deploy-av <12-hex tag> (infra/demo-vm/deploy.sh)"
